import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

const bucket = process.argv[2];
if (!bucket) {
  console.error("usage: node scripts/ci-create-s3-bucket.mjs <bucket>");
  process.exit(2);
}

const client = new S3Client({
  endpoint: process.env.S3_ENDPOINT || "http://localhost:9000",
  region: process.env.S3_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "minioadmin",
  },
  forcePathStyle: true,
});

try {
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`Created S3 bucket ${bucket}`);
} catch (error) {
  const status = error?.$metadata?.httpStatusCode;
  if (error?.name === "BucketAlreadyOwnedByYou" || error?.name === "BucketAlreadyExists" || status === 409) {
    console.log(`S3 bucket ${bucket} already exists`);
  } else {
    throw error;
  }
} finally {
  client.destroy();
}
