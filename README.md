# PlaceCanvas

A browser-based drawing tool for [MemeApi](https://github.com/madswolf/MemeApi) Place submissions. Built on [miniPaint](https://github.com/viliusle/miniPaint).

Users paint on top of the current Place image and submit their changes. The app handles authentication, pixel-change pricing, and image submission automatically.

## How it works

1. On load, the latest Place image is fetched and locked as the bottom layer — it cannot be selected, edited, or deleted.
2. A blank paint layer is added above it for the user to draw on.
3. The base image refreshes every 30 seconds in the background.
4. Clicking **Submit to Place** calculates the number of changed pixels, shows the token cost, and on confirmation posts the composite image to the API.

## Configuration

Three variables are baked into the bundle at build time:

| Variable | Description |
|---|---|
| `PLACE_API_URL` | Base URL of the MemeApi instance (no trailing slash) |
| `PLACE_ID` | UUID of the Place to load and submit to |
| `PLACE_MEDIA_HOST` | Base URL of the media/file server that hosts the Place images |

Copy `.env.example` to `.env` and fill in your values for local development:

```
PLACE_API_URL=https://your-memeapi.example.com
PLACE_ID=your-place-id
PLACE_MEDIA_HOST=https://your-media-host.example.com
```

All three values can be overridden at runtime with URL query parameters:

```
https://madswolf.github.io/PlaceCanvas/?apiUrl=https://other-api.example.com&placeId=abc123&mediaHost=https://other-media.example.com
```

## Deployment (GitHub Pages)

The repository includes a GitHub Actions workflow (`.github/workflows/deploy.yml`) that builds the frontend and publishes it to GitHub Pages on every push to `master`.

### One-time setup

**1. Enable GitHub Pages**

Go to your repository → **Settings → Pages** and set:
- Source: **GitHub Actions**

**2. Add repository secrets**

Go to **Settings → Secrets and variables → Actions → Repository secrets** and add:

| Secret name | Value |
|---|---|
| `PLACE_API_URL` | e.g. `https://your-memeapi.example.com` |
| `PLACE_ID` | e.g. `c6a058f9-8ce4-40e0-bd55-8f98d249f7aa` |
| `PLACE_MEDIA_HOST` | e.g. `https://your-media-host.fra1.digitaloceanspaces.com` |

These are passed as environment variables during the build step so they get compiled into `bundle.js`. They are never written to disk or exposed in the repository.

**3. Push to master**

The workflow triggers automatically on every push to `master`. You can also run it manually from the **Actions** tab using **Run workflow**.

The deployed site will be available at:
```
https://madswolf.github.io/PlaceCanvas/
```

## Authentication

Authentication uses a short-lived temporary password issued by the MemeApi bot:

```
http://localhost:8080/?tempPassword=<temporary_password>
```

The app exchanges it for an access token and refresh token, stores them in `localStorage`, and handles silent renewal before expiry. The `tempPassword` is stripped from the URL immediately after use.

If the session expires, reload the page with a fresh `?tempPassword=`.

## Local development

Install dependencies:

```bash
npm install
```

Start the dev server with hot reload:

```bash
npm run server
```

The dev server opens at `http://localhost:8080` by default.

Build a development bundle (no minification):

```bash
npm run dev
```

Build a production bundle:

```bash
npm run build
```

Output lands in `dist/bundle.js`.

## Browser support

Chrome, Firefox, Edge, Opera, Safari

## License

MIT
