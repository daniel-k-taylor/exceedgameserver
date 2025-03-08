import os
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv
from pathlib import Path
import json

# Load environment variables from .env one directory up
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

# Get connection string from environment
AZURE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
if not AZURE_CONNECTION_STRING:
    raise ValueError("AZURE_STORAGE_CONNECTION_STRING not found in environment variables")

CONTAINER_NAME = "exceed-customs"
MANIFEST_FILE = "customs_manifest.json"


def main():
    # Create a blob service client
    blob_service_client = BlobServiceClient.from_connection_string(AZURE_CONNECTION_STRING)

    # Read the manifest file as json.
    try:
        with open(MANIFEST_FILE, "r") as f:
            manifest_json = json.load(f)
    except FileNotFoundError:
        print(f"Error: File {MANIFEST_FILE} not found")
        return

    # Get the customs from the manifest
    customs = manifest_json.get("customs", [])
    # Upload each customs file to the blob storage
    for custom in customs:
        try:
            # Get the container client
            custom_file_path = os.path.join("customs", custom)
            with open(custom_file_path, "rb") as data:
                # Upload the file to the blob, overwriting if it exists
                container_client = blob_service_client.get_container_client(CONTAINER_NAME)
                container_client.upload_blob(name=custom, data=data, overwrite=True)
            print(f"Successfully uploaded {custom} in container {CONTAINER_NAME}")
        except FileNotFoundError:
            print(f"Error: File {custom_file_path} not found")
        except Exception as e:
            print(f"An error occurred: {e}")

    # Upload the manifest.
    try:
        with open(MANIFEST_FILE, "rb") as data:
            # Upload the file to the blob, overwriting if it exists
            container_client = blob_service_client.get_container_client(CONTAINER_NAME)
            container_client.upload_blob(name=MANIFEST_FILE, data=data, overwrite=True)
        print(f"Successfully uploaded {MANIFEST_FILE} in container {CONTAINER_NAME}")
    except FileNotFoundError:
        print(f"Error: File {MANIFEST_FILE} not found")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
