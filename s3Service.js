
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const bucketName = process.env.AWS_BUCKET;

if (!region || !accessKeyId || !secretAccessKey || !bucketName) {
    console.error('AWS configuration is missing. Please check your environment variables.');
}

const s3Client = new S3Client({
    region,
    credentials: {
        accessKeyId,
        secretAccessKey,
    },
});

export const uploadFile = async (file, folder = 'uploads') => {
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${folder}/${uuidv4()}.${fileExtension}`;

    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: file.buffer,
        ContentType: file.mimetype,
    });

    await s3Client.send(command);

    // Return the file key (path in S3)
    return fileName;
};

export const getPresignedUrl = async (fileKey, expiresIn = 3600) => {
    if (!fileKey) return null;

    // If it's already a full URL (legacy Cloudinary), return as is
    if (fileKey.startsWith('http')) return fileKey;

    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
    });

    const url = await getSignedUrl(s3Client, command, { expiresIn });
    return url;
};

export const getFile = async (fileKey) => {
    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: fileKey,
    });

    const response = await s3Client.send(command);
    return {
        body: response.Body,
        contentType: response.ContentType,
    };
};
