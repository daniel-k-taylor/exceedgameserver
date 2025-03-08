
import { BlobServiceClient } from "@azure/storage-blob";

const JSON5 = await import('json5');

const CONFIG_CONTAINER_NAME = 'exceed-config';
const CONFIG_BLOB_NAME = 'server_config.json';

const CUSTOMS_CONTAINER_NAME = 'exceed-customs';
const CUSTOMS_MANIFEST_BLOB_NAME = 'customs_manifest.json';

// Helper function to convert a stream to a string
async function streamToString(readableStream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        readableStream.on('data', (data) => {
            chunks.push(data.toString());
        });
        readableStream.on('end', () => {
            resolve(chunks.join(''));
        });
        readableStream.on('error', reject);
    });
}

async function download_file_from_blob_storage(container, filename) {
    try {
        const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

        if (!AZURE_STORAGE_CONNECTION_STRING) {
            throw new Error('Azure Storage Connection string not found');
        }

        // Create the BlobServiceClient object with connection string
        const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

        // Get a reference to a container
        const containerClient = blobServiceClient.getContainerClient(container);

        // Download the server config json blob.
        const blockBlobClient = containerClient.getBlockBlobClient(filename);
        const downloadBlockBlobResponse = await blockBlobClient.download(0);
        const downloaded = await streamToString(downloadBlockBlobResponse.readableStreamBody);
        return JSON5.default.parse(downloaded);
    }
    catch (error) {
        console.error('Error:', error);
    }
}

export async function get_server_config() {
    return download_file_from_blob_storage(CONFIG_CONTAINER_NAME, CONFIG_BLOB_NAME);
}

export async function update_customs_db(current_customs_db) {

    var current_version = current_customs_db["version"]

    // Download the latest manifest from blob storage.
    var latest_customs_manifest = await download_file_from_blob_storage(CUSTOMS_CONTAINER_NAME, CUSTOMS_MANIFEST_BLOB_NAME)
    if (!latest_customs_manifest) {
        console.error('Error downloading customs_manifest.json from blob storage');
        return current_customs_db
    }
    var latest_version = latest_customs_manifest["version"]
    if (latest_version == current_version) {
        // No update needed.
        return current_customs_db
    }

    // Download all characters in the manifest.
    for (const custom of latest_customs_manifest["customs"]) {
        var character_data = await download_file_from_blob_storage(CUSTOMS_CONTAINER_NAME, custom)
        if (!character_data) {
            console.error(`Error downloading ${custom} from blob storage`);
            continue
        }
        const base_custom_name = custom.split(".")[0]
        current_customs_db["customs"][base_custom_name] = character_data
    }
    // Update the version.
    current_customs_db["version"] = latest_version

    return current_customs_db
}

export async function upload_to_blob_storage(matchData) {
    if (process.env.SKIP_MATCH_UPLOAD) {
        console.log("Skipping match upload to blob storage.");
        return
    }
    try {
        const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

        if (!AZURE_STORAGE_CONNECTION_STRING) {
            console.log('Azure Storage Connection string not found');
            return
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