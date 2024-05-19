
import { BlobServiceClient } from "@azure/storage-blob";

export async function upload_to_blob_storage(matchData) {
    try {
        const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

        if (!AZURE_STORAGE_CONNECTION_STRING) {
            throw Error('Azure Storage Connection string not found');
        }

        // Create the BlobServiceClient object with connection string
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

        const containerName = 'matchlogs';

        // Get a reference to a container
        const containerClient = blobServiceClient.getContainerClient(containerName);

        // Create a unique name for the blob
        const blobName = 'match_' + matchData['MatchId'] + '_version_' + matchData['GameVersion'] + '.json';

        // Get a block blob client
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        // Display blob name and url
        console.log(
            `\nUploading to Azure storage as blob\n\tname: ${blobName}:\n\tURL: ${blockBlobClient.url}`
        );

        // Upload data to the blob.
        // Convert matchData from JSON to string.
        const data = JSON.stringify(matchData);
        const uploadBlobResponse = await blockBlobClient.upload(data, data.length);
        console.log(
            `Blob was uploaded successfully. requestId: ${uploadBlobResponse.requestId}`
        );

    }
    catch (error) {
        console.error('Error:', error);
    }
}