This server_config json needs to be uploaded to:
Storage account: fightingcardsstorage
Container: exceed-config
Blob: server_config.json

# Setup
1. Ensure AZURE_STORAGE_CONNECTION_STRING is set
2. python -m venv venv
3. venv\scripts\activate
4. pip install -r requirements.txt

# Upload config
1. venv\scripts\activate
2. python upload_server_config.py


# Customs
When adding a custom:
1. Drop the json in the customs dir
2. Add it to the manifest
3. Increment the manifest version
4. venv\scripts\activate
5. python upload_customs.py