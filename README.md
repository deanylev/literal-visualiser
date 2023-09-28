# Literal Visualiser
Play songs from Spotify backed by AI generated images corresponding to each verse. Written in Node.js and React w/ TypeScript.

Live version available here: https://literalvisualiser.com.

## Running

### Frontend
In `frontend`, run `yarn` to install dependencies, then `yarn start` or `yarn build`.

### Backend
Run `yarn` to install dependencies, then set your environment variables and run `yarn start` to start the server.

## Environment Variables
`DB_HOST` - MySQL host, defaults to `"localhost:3006"`
`DB_NAME` - MySQL DB name, defaults to `"literal_visualiser"`
`DB_PASS` - MySQL DB password, defaults to `""`
`DB_USER` - MySQL DB user, defaults to `"root"`
`IMAGE_GEN_URL` - Service to use for image generation, must be set
`NODE_ENV` - The Node environment to use, defaults to `"development"`
`PORT` - The port to run the HTTP server on, defaults to `"8080"`
`SPOTIFY_CLIENT_ID` - Your Spotify app's client ID, must be set
`SPOTIFY_CLIENT_SECRET` - Your Spotify app's client secret, must be set
`SPOTIFY_DC` - Your `sp_dc` cookie from Spotify web player, used for lyrics fetching, must be set

