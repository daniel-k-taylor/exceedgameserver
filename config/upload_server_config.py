import os
from azure.storage.blob import BlobServiceClient
from dotenv import load_dotenv
from pathlib import Path

# Load environment variables from .env one directory up
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

# Get connection string from environment
AZURE_CONNECTION_STRING = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
if not AZURE_CONNECTION_STRING:
    raise ValueError("AZURE_STORAGE_CONNECTION_STRING not found in environment variables")

# Define container and blob names
CONTAINER_NAME = "exceed-config"
BLOB_NAME = "server_config.json"

# Path to the local file
LOCAL_FILE_PATH = "server_config.json"

# Create a blob service client
blob_service_client = BlobServiceClient.from_connection_string(AZURE_CONNECTION_STRING)

# Get the container client
container_client = blob_service_client.get_container_client(CONTAINER_NAME)

# Read the local file
try:
    with open(LOCAL_FILE_PATH, "rb") as data:
        # Upload the file to the blob, overwriting if it exists
        container_client.upload_blob(name=BLOB_NAME, data=data, overwrite=True)
    print(f"Successfully uploaded {LOCAL_FILE_PATH} to {BLOB_NAME} in container {CONTAINER_NAME}")
except FileNotFoundError:
    print(f"Error: File {LOCAL_FILE_PATH} not found")
except Exception as e:
    print(f"An error occurred: {e}")
