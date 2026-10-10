# Compliance Knowledge Repository — PostgreSQL full-stack project

Express API + PostgreSQL + the supplied HTML frontend. No login or role-based authorization is enabled: anyone with the public URL can view and change shared data.

## 1. Run locally first (recommended)

Requirements: Docker Desktop (running) and Git.

1. Extract this folder.
2. In Terminal, `cd` into the folder containing `Dockerfile` and `docker-compose.yml`.
3. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and replace `DB_PASSWORD` with a strong password.
5. Start the app and PostgreSQL:

   ```bash
   docker compose up --build -d
   ```

6. Open <http://localhost:3000>.
7. Check database health at <http://localhost:3000/api/health>. It should return `{"ok":true,"database":"connected"}`.
8. View logs with `docker compose logs -f app`.
9. Stop with `docker compose down`. Data volumes remain. `docker compose down -v` deletes the database and uploaded files; use only if you intend to erase them.

## 2. Free deployment (Render + Neon PostgreSQL)

This avoids Render's free PostgreSQL 30-day expiry by using a separate PostgreSQL provider. Free tiers have limits and can change; review provider pricing and backups before storing important data.

### A. Push the project to GitHub

1. Create/open a GitHub repository.
2. Upload the *contents* of this folder to the repository root. `Dockerfile`, `package.json`, `server/`, and `public/` should be at the root level.
3. Commit and push to the `main` branch.

### B. Create PostgreSQL on Neon

1. Go to <https://neon.tech/> and create a project.
2. Copy the connection string from the Neon dashboard. Keep it private; it contains a password.

### C. Deploy the app on Render

1. Go to <https://render.com/> and sign in.
2. Choose **New → Web Service**, then connect your GitHub repository.
3. Choose the `main` branch.
4. Select **Docker** as the runtime. Leave Root Directory blank if the Dockerfile is at the repository root.
5. Choose the **Free** instance if offered.
6. Add these environment variables in the Render service settings:

   - `DATABASE_URL` = the Neon connection string
   - `DB_SSL` = `true`
   - `MAX_UPLOAD_MB` = `50`
   - `UPLOAD_DIR` = `/tmp/uploads`

   Render provides the `PORT` variable automatically; the server listens on it. Do not add a MySQL `DB_HOST`/`DB_PORT` configuration when using `DATABASE_URL`.

7. Click **Create Web Service** and wait for the deployment to finish.
8. In Render, open the generated URL. Then open `<your-render-url>/api/health`. A successful result should show `ok: true` and `database: connected`.

## Important free-tier file-storage limitation

The database records persist in Neon, but this version stores uploaded file bytes on the app's local filesystem. Render Free has an ephemeral filesystem, so uploaded PDFs/spreadsheets may disappear when the app restarts or redeploys. `UPLOAD_DIR=/tmp/uploads` makes the service writable but does **not** make uploads permanent. For reliable file uploads, the next required change is to move blob storage to a persistent object-storage service (for example Supabase Storage or another S3-compatible service) and configure backups. Do not use this deployment for important customer/compliance files until that is done.

## API overview

- `GET /api/health` — application/database health
- `GET /api/collections/:collection` — list documents
- `GET /api/collections/:collection/doc/:id` — get a document
- `PUT /api/collections/:collection/doc/:id` — create/replace a document
- `PATCH /api/collections/:collection/doc/:id` — update document fields
- `DELETE /api/collections/:collection/doc/:id` — delete a document
- `POST /api/blobs` — upload file (`multipart/form-data`, field name `file`)
- `GET /_blob/:id` — read/download uploaded file
- `DELETE /api/blobs/:id` — delete uploaded file

## Security

There is intentionally no authentication/authorization. Anyone who can access the public URL can edit and delete shared content. Do not put confidential or customer data on a public no-login deployment. Use strong secrets, keep the database connection string private, and make regular backups.

AI-generated quiz questions still require an AI provider integration; this project does not invent or include an AI API key.
