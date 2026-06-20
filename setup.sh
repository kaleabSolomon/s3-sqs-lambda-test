#!/bin/bash
set -e

# Define awslocal specifically for this script since aliases don't pass into bash scripts
awslocal() {
    aws --endpoint-url=http://localhost:4566 "$@"
}

echo "📦 Creating AWS Infrastructure..."
awslocal s3 mb s3://video-uploads
awslocal sqs create-queue --queue-name video-processing-queue
awslocal dynamodb create-table \
    --table-name VideoMetadata \
    --attribute-definitions AttributeName=videoId,AttributeType=S \
    --key-schema AttributeName=videoId,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
awslocal s3api put-bucket-notification-configuration \
    --bucket video-uploads \
    --notification-configuration file://notification.json

echo "🚀 Compiling and Deploying Lambda..."
cd lambda
npx tsc
# FIX: We MUST include package.json in the zip so Lambda knows it's an ES Module!
zip function.zip index.js package.json

# Delete the function if it already exists
awslocal lambda delete-function --function-name VideoProcessor 2>/dev/null || true

awslocal lambda create-function \
    --function-name VideoProcessor \
    --runtime nodejs20.x \
    --role arn:aws:iam::000000000000:role/dummy-role \
    --handler index.handler \
    --zip-file fileb://function.zip

echo "🔗 Connecting SQS to Lambda..."
awslocal lambda create-event-source-mapping \
    --function-name VideoProcessor \
    --event-source-arn arn:aws:sqs:eu-central-1:000000000000:video-processing-queue

echo "✅ Done! Everything is rebuilt and ready to test."
