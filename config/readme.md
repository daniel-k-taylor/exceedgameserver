This server_config json needs to be uploaded to:
Storage account: fightingcardsstorage
Container: exceed-config
Blob: server_config.json

Setup:
1. Ensure AZURE_STORAGE_CONNECTION_STRING is set
2. python -m venv venv
3. venv\scripts\activate
4. pip install -r requirements.txt

To upload a new config:
1. venv\scripts\activate
2. python upload_server_config.py
