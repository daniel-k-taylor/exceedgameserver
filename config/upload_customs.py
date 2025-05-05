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

    customs_dir = os.path.join("customs")
    # List all .json files in the customs directory
    customs_files = [
        f for f in os.listdir(customs_dir)
        if os.path.isfile(os.path.join(customs_dir, f)) and f.endswith(".json")
    ]
    customs_files.sort()

    # Get the last modification time among all customs files
    latest_mtime = 0
    for f in customs_files:
        mtime = os.path.getmtime(os.path.join(customs_dir, f))
        if mtime > latest_mtime:
            latest_mtime = mtime

    # Read the manifest file as json, or create a new one if missing
    manifest_json = {}
    try:
        with open(MANIFEST_FILE, "r") as f:
            manifest_json = json.load(f)
    except FileNotFoundError:
        manifest_json = {}

    # Increment version (default to 1 if missing)
    version = manifest_json.get("version", 0)
    manifest_json["version"] = version + 1

    # Update customs and last_write_time
    manifest_json["customs"] = customs_files
    import datetime
    manifest_json["last_write_time"] = datetime.datetime.fromtimestamp(latest_mtime).isoformat()

    # Write updated manifest
    with open(MANIFEST_FILE, "w") as f:
        json.dump(manifest_json, f, indent=4)

    # Upload each customs file to the blob storage
    for custom in customs_files:
        try:
            custom_file_path = os.path.join("customs", custom)
            with open(custom_file_path, "rb") as data:
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
            container_client = blob_service_client.get_container_client(CONTAINER_NAME)
            container_client.upload_blob(name=MANIFEST_FILE, data=data, overwrite=True)
        print(f"Successfully uploaded {MANIFEST_FILE} in container {CONTAINER_NAME}")
    except FileNotFoundError:
        print(f"Error: File {MANIFEST_FILE} not found")
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
