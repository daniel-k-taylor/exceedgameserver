import path from 'path';
import fs from 'fs';
import unzipper from 'unzipper';
import { BlobServiceClient } from "@azure/storage-blob";

const JSON5 = await import('json5');

const CONFIG_CONTAINER_NAME = 'exceed-config';
const CONFIG_BLOB_NAME = 'server_config.json';

const CUSTOMS_CONTAINER_NAME = 'exceed-customs';
const CUSTOMS_MANIFEST_BLOB_NAME = 'customs_manifest.json';

const GAME_ZIP_CONTAINER_NAME = 'exceed-game-files';
const GAME_ZIP_BLOB_NAME = 'game.zip';

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

function getContainerClient(containerName) {
    const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;

    if (!AZURE_STORAGE_CONNECTION_STRING) {
        throw new Error('Azure Storage Connection string not found');
    }

    // Create the BlobServiceClient object with connection string
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);

    // Get a reference to a container
    return blobServiceClient.getContainerClient(containerName);
}

async function download_file_from_blob_storage(container, filename) {
    try {
        const containerClient = getContainerClient(container);

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
        // Remove only the last .json or other extension
        const base_custom_name = custom.replace(/\.[^/.]+$/, "");
        current_customs_db["customs"][base_custom_name] = character_data
    }
    // Remove customs that are no longer in the latest manifest.
    if (latest_customs_manifest["customs"] && Array.isArray(latest_customs_manifest["customs"])) {
        const latest_custom_names_set = new Set(
            latest_customs_manifest["customs"].map(c => c.replace(/\.[^/.]+$/, ""))
        );
        for (const custom_name of Object.keys(current_customs_db["customs"])) {
            if (!latest_custom_names_set.has(custom_name)) {
                delete current_customs_db["customs"][custom_name];
            }
        }
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

export async function checkAndDownloadUpdatedGameZip(gamePath) {
    const localPath = path.join(gamePath, GAME_ZIP_BLOB_NAME);
    try {
        const containerClient = getContainerClient(GAME_ZIP_CONTAINER_NAME);
        const blobClient = containerClient.getBlobClient(GAME_ZIP_BLOB_NAME);
        const properties = await blobClient.getProperties();
        const remoteLastModified = new Date(properties.lastModified);

        // Check local file's last modified time if it exists
        let localLastModified = null;
        if (fs.existsSync(localPath)) {
            const stats = fs.statSync(localPath);
            localLastModified = stats.mtime;
        }

        if (!localLastModified || remoteLastModified > localLastModified) {
            console.log('Newer version found, downloading...');

            fs.mkdirSync(gamePath, { recursive: true });

            await blobClient.downloadToFile(localPath);
            console.log('Download complete');

            // Extract the zip to gamePath, ovewriting anything.
            if (fs.existsSync(gamePath)) {
                fs.readdirSync(gamePath).forEach(file => {
                    if (file !== 'game.zip') { // Skip the zip file
                        fs.rmSync(path.join(gamePath, file), { recursive: true, force: true });
                    }
                });
            }

            // Extract the zip
            fs.createReadStream(localPath)
                .pipe(unzipper.Extract({ path: gamePath }))
                .on('close', () => console.log('Game zip extracted successfully'))
                .on('error', (err) => console.error('Error extracting game zip:', err));
        } else {
            console.log('Local version is up to date');
        }
    } catch (error) {
        console.error('Error checking or downloading game zip:', error);
    }
}