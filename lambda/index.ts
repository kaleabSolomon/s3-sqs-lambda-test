import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SQSEvent, SQSBatchResponse } from "aws-lambda";

const region = process.env.AWS_REGION ?? "eu-central-1";

// AWS SDK v3 reads AWS_ENDPOINT_URL natively — no manual plumbing needed.
const s3Client = new S3Client({
  region,
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const dynamoClient = new DynamoDBClient({
  region,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

async function processRecord(
  bucket: string,
  key: string,
): Promise<void> {
  console.log(`Processing video: ${key} from bucket: ${bucket}`);

  const s3ObjectMetadata = await s3Client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key }),
  );
  const fileSize = s3ObjectMetadata.ContentLength ?? 0;

  // Note: codec, resolution, and duration are mocked.
  // In a real app, download the video from S3 and run FFmpeg here.
  await dynamoClient.send(
    new PutItemCommand({
      TableName: "VideoMetadata",
      Item: {
        videoId: { S: key },
        sizeBytes: { N: fileSize.toString() },
        durationSeconds: { N: "120" },
        resolution: { S: "1080p" },
        codec: { S: "H.264" },
        processedAt: { S: new Date().toISOString() },
      },
      // Prevent silent overwrites — fail if this videoId was already processed.
      ConditionExpression: "attribute_not_exists(videoId)",
    }),
  );

  console.log(`Successfully saved metadata for ${key} to DynamoDB!`);
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  console.log("Received SQS event:", JSON.stringify(event, null, 2));

  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as {
        Records?: {
          s3: { bucket: { name: string }; object: { key: string } };
        }[];
      };

      if (!body.Records) continue; // Skip test events

      for (const s3Record of body.Records) {
        const bucket = s3Record.s3.bucket.name;
        const key = decodeURIComponent(
          s3Record.s3.object.key.replace(/\+/g, " "),
        );

        if (s3Record.s3.object.key.endsWith("/")) continue; // Skip folder markers

        try {
          await processRecord(bucket, key);
        } catch (error) {
          if (error instanceof ConditionalCheckFailedException) {
            // Already processed — not a failure, just skip it.
            console.log(`Skipping already-processed video: ${key}`);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error processing SQS record ${record.messageId}:`, error);
      // Report this individual message as failed rather than failing the whole batch.
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
