# PlaceCanvas

A browser-based drawing tool for [MemeApi](https://github.com/madswolf/MemeApi) Place submissions. Built on [miniPaint](https://github.com/viliusle/miniPaint).

Users paint on top of the current Place image and submit their changes. The app handles authentication, pixel-change pricing, and image submission automatically.

## How it works

1. On load, the latest Place image is fetched and locked as the bottom layer — it cannot be selected, edited, or deleted.
2. A blank paint layer is added above it for the user to draw on.
3. The base image refreshes every 30 seconds in the background.
4. Clicking **Submit to Place** calculates the number of changed pixels, shows the token cost, and on confirmation posts the composite image to the API.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```
PLACE_API_URL=https://your-memeapi.example.com
PLACE_ID=your-place-id
```

These are baked into the bundle at build time. The values can be overridden at runtime with URL query parameters:

```
http://localhost:8080/?apiUrl=https://other-api.example.com&placeId=abc123
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
