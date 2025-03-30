import argparse
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
CONTAINER_NAME = "exceed-game-files"
BLOB_NAME = "game.zip"


DT_GAME_ZIP_PATH = r"E:\Projects\godot\cardgame\export\game.zip"

# Create a main func and if
# __name__ == "__main__": call main

def main(game_zip_path):
    if not game_zip_path:
        game_zip_path = DT_GAME_ZIP_PATH
    if not os.path.isfile(game_zip_path):
        print(f"Error: File {game_zip_path} not found")
        return

    # Create a blob service client
    blob_service_client = BlobServiceClient.from_connection_string(AZURE_CONNECTION_STRING)

    # Get the container client
    container_client = blob_service_client.get_container_client(CONTAINER_NAME)

    # Read the local file
    try:
        with open(game_zip_path, "rb") as data:
            # Upload the file to the blob, overwriting if it exists
            container_client.upload_blob(name=BLOB_NAME, data=data, overwrite=True)
        print(f"Successfully uploaded {game_zip_path} to {BLOB_NAME} in container {CONTAINER_NAME}")
    except FileNotFoundError:
        print(f"Error: File {game_zip_path} not found")
    except Exception as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Upload a game zip file to Azure Blob Storage.")
    parser.add_argument("-g", "--game_zip_path", type=str, help="Path to the game zip file.")
    args = parser.parse_args()
    main(args.game_zip_path)