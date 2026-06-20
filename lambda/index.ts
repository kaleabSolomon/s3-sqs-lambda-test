import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SQSEvent } from "aws-lambda";

const endpoint = process.env.AWS_ENDPOINT || "http://host.docker.internal:4566";

const s3Client = new S3Client({
  endpoint: endpoint,
  region: "eu-central-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const dynamoClient = new DynamoDBClient({
  endpoint: endpoint,
  region: "eu-central-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export const handler = async (event: SQSEvent): Promise<void> => {
  console.log("Received SQS event:", JSON.stringify(event, null, 2));
  // The queue could send us multiple messages at once in a batch
  for (const record of event.Records) {
    // 3. S3 wraps its event inside the SQS message body as a JSON string
    const body = JSON.parse(record.body);
    if (!body.Records) continue; // Skip test events
    for (const s3Record of body.Records) {
      const bucket = s3Record.s3.bucket.name;
      // Decode the filename in case it has spaces
      const key = decodeURIComponent(
        s3Record.s3.object.key.replace(/\+/g, " "),
      );

      console.log(`Processing video: ${key} from bucket: ${bucket}`);
      try {
        // 4. Fetch the real file size from S3
        const headParams = { Bucket: bucket, Key: key };
        const s3ObjectMetadata = await s3Client.send(
          new HeadObjectCommand(headParams),
        );
        const fileSize = s3ObjectMetadata.ContentLength || 0;
        // 5. Build our Metadata object.
        // Note: For this tutorial, we are mocking the codec, resolution, and duration.
        // In a real app, you would download the video from S3 and run FFmpeg here!
        const videoMetadata = {
          videoId: { S: key },
          sizeBytes: { N: fileSize.toString() },
          durationSeconds: { N: "120" },
          resolution: { S: "1080p" },
          codec: { S: "H.264" },
          processedAt: { S: new Date().toISOString() },
        };
        // 6. Save the data to our DynamoDB table
        const putParams = {
          TableName: "VideoMetadata",
          Item: videoMetadata,
        };
        await dynamoClient.send(new PutItemCommand(putParams));
        console.log(`Successfully saved metadata for ${key} to DynamoDB!`);
      } catch (error) {
        console.error(`Error processing video ${key}:`, error);
        // Throwing the error tells SQS the job failed. SQS will automatically retry it!
        throw error;
      }
    }
  }
};
