import express from 'express';
import SpotifyWebApi from 'spotify-web-api-node';
import dotenv from 'dotenv';
import session from 'express-session';
import arcjet, {detectBot, shield, fixedWindow} from '@arcjet/node';
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const spotifyAPI = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI,
});

app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));


const checkAuth = (req, res, next) => {
  if (!req.session.accessToken) {
    return res.redirect('/');
  }
  next();
};

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({
      mode: "LIVE", 
    }),
    fixedWindow({
      mode: "LIVE",
      characteristics: ["ip.src"],
      match:"/generate-playlist",
      window: "1m",
      max: 1,
    }),
    detectBot({
      mode: "LIVE",
      block: [        
        "AUTOMATED",
      ],
      patterns: {
        remove: [
          "^curl",
        ],
      },
    }),
  ],
});

app.use(async (req, res, next) => {
  try {
    const decision = await aj.protect(req);
    if (decision.isDenied()) {

      console.error("Arcjet protection denied", decision);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Forbidden" }));

    } else {
      next();
    }
  } catch (error) {
    console.error("Arcjet protection error", error);
    res.status(500).send({ error: 'Internal Server Error' });
  }
});

const refreshAccessToken = async (req, res, next) => {
  try {
    if (req.session.accessToken && req.session.refreshToken) {
      spotifyAPI.setRefreshToken(req.session.refreshToken);
      const data = await spotifyAPI.refreshAccessToken();
      req.session.accessToken = data.body['access_token'];
      spotifyAPI.setAccessToken(req.session.accessToken);
      console.log('Access token refreshed successfully');
    } else {
      console.warn('Access token or refresh token missing in session');
      return res.status(401).send('Authentication required');
    }
    next();
  } catch (error) {
    console.error('Error refreshing access token:', error);
    if (error.statusCode === 401) {
      return res.status(401).send('Invalid or expired refresh token');
    }
    res.status(500).send('Internal Server Error');
  }
};

app.get('/', (req, res) => {
  res.render('index', { loggedIn: !!req.session.accessToken });
});


app.get('/login', (req, res) => {
  const scopes = ['playlist-modify-public', 'playlist-modify-private'];
  const authorizeURL = spotifyAPI.createAuthorizeURL(scopes);
  res.redirect(authorizeURL);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const data = await spotifyAPI.authorizationCodeGrant(code);
    req.session.accessToken = data.body['access_token'];
    req.session.refreshToken = data.body['refresh_token'];
    spotifyAPI.setAccessToken(req.session.accessToken);
    spotifyAPI.setRefreshToken(req.session.refreshToken);
    res.redirect('/');
  } catch (err) {
    console.error('Error during authorization', err);
    res.status(500).send('Authorization Error');
  }
});

app.post('/generate-playlist', checkAuth, refreshAccessToken, async (req, res) => {
  const { artistName, mood } = req.body;

  try {
    const artistData = await spotifyAPI.searchArtists(artistName);
    if (artistData.body.artists.items.length === 0) {
      return res.status(404).send('Artist not found');
    }

    const artistId = artistData.body.artists.items[0].id;
    const recommendations = await spotifyAPI.getRecommendations({
      seed_artists: [artistId],
      seed_genres: [mood],
      limit: 12,
    });

    const tracks = recommendations.body.tracks.map(track => ({
      name: track.name,
      album: track.album.name,
      artists: track.artists.map(artist => artist.name).join(', '),
      duration: `${Math.floor(track.duration_ms / 60000)}:${((track.duration_ms % 60000) / 1000).toFixed(0).padStart(2, '0')}`,
      uri: track.uri,
      external_url: track.external_urls.spotify,
    }));

    res.render('playlist', { tracks });
  } catch (error) {
    console.error('Error generating playlist:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/save-playlist', checkAuth, refreshAccessToken, async (req, res) => {
  const { playlistName, trackUris } = req.body;

  try {
    const userData = await spotifyAPI.getMe();
    const userId = userData.body.id;

    const newPlaylist = await spotifyAPI.createPlaylist(userId, {
      name: playlistName,
      public: false
    });

    await spotifyAPI.addTracksToPlaylist(newPlaylist.body.id, JSON.parse(trackUris));

    res.status(200).send(`Playlist '${playlistName}' created successfully!`);
  } catch (error) {
    console.error('Error creating playlist:', error);

    if (error.response) {
      console.error('Spotify API response:', error.response);
      res.status(error.response.status).send(error.response.data);
    } else {
      res.status(500).send('Internal Server Error');
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});