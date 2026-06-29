#!/bin/bash
set -e

REGION="eu-central-1"
ACCOUNT_ID="000000000000"
ENDPOINT="http://localhost:4566"

awslocal() {
    aws --endpoint-url="$ENDPOINT" "$@"
}

echo "📦 Creating AWS Infrastructure..."

# S3
awslocal s3 mb s3://video-uploads 2>/dev/null || echo "  s3://video-uploads already exists, skipping."

# DLQ — must exist before the main queue so we can reference its ARN
awslocal sqs create-queue --queue-name video-processing-dlq 2>/dev/null || echo "  DLQ already exists, skipping."

DLQ_ARN=$(awslocal sqs get-queue-attributes \
    --queue-url "$ENDPOINT/000000000000/video-processing-dlq" \
    --attribute-names QueueArn \
    --query Attributes.QueueArn --output text)

# Main queue with redrive policy pointing at the DLQ (retry up to 3 times)
REDRIVE_POLICY="{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"3\"}"
awslocal sqs create-queue \
    --queue-name video-processing-queue \
    --attributes RedrivePolicy="$REDRIVE_POLICY" 2>/dev/null || echo "  Main queue already exists, skipping."

# DynamoDB
awslocal dynamodb create-table \
    --table-name VideoMetadata \
    --attribute-definitions AttributeName=videoId,AttributeType=S \
    --key-schema AttributeName=videoId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST 2>/dev/null || echo "  VideoMetadata table already exists, skipping."

# S3 → SQS notification
awslocal s3api put-bucket-notification-configuration \
    --bucket video-uploads \
    --notification-configuration file://notification.json

echo "🚀 Compiling and Deploying Lambda..."
cd lambda
npx tsc
zip function.zip index.js package.json

# Delete and recreate the function to pick up code + env changes cleanly
awslocal lambda delete-function --function-name VideoProcessor 2>/dev/null || true

awslocal lambda create-function \
    --function-name VideoProcessor \
    --runtime nodejs20.x \
    --role arn:aws:iam::${ACCOUNT_ID}:role/dummy-role \
    --handler index.handler \
    --zip-file fileb://function.zip \
    --environment "Variables={AWS_ENDPOINT_URL=http://host.docker.internal:4566,AWS_REGION=$REGION}"

echo "🔗 Connecting SQS to Lambda (with partial batch failure reporting)..."

# Delete existing mapping first so re-runs are idempotent
EXISTING_UUID=$(awslocal lambda list-event-source-mappings \
    --function-name VideoProcessor \
    --query "EventSourceMappings[0].UUID" --output text 2>/dev/null || true)
if [ "$EXISTING_UUID" != "None" ] && [ -n "$EXISTING_UUID" ]; then
    awslocal lambda delete-event-source-mapping --uuid "$EXISTING_UUID" 2>/dev/null || true
fi

awslocal lambda create-event-source-mapping \
    --function-name VideoProcessor \
    --event-source-arn "arn:aws:sqs:$REGION:$ACCOUNT_ID:video-processing-queue" \
    --function-response-types ReportBatchItemFailures

echo "✅ Done! Everything is rebuilt and ready to test."
