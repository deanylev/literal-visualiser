import fs from 'fs';
import { AddressInfo } from 'net';
import { resolve } from 'path';

import axios from 'axios';
import cors from 'cors';
import express from 'express';
import { createPool, Pool, RowDataPacket } from 'mysql2/promise';
import { v4 } from 'uuid';

import { get, set } from './data-store';

const {
  DB_HOST,
  DB_NAME,
  DB_PASS,
  DB_USER,
  IMAGE_GEN_URL,
  NODE_ENV,
  PORT,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_DC
} = process.env;
if (!(IMAGE_GEN_URL && SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_DC)) {
  console.error('IMAGE_GEN_URL, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_DC  must be set');
  process.exit(1);
}

type Lyrics = {
  imageUri: string;
  startTimeMs: number;
  words: string;
}[];

type Generation = {
  status: 'waiting'
  queuePosition: number;
} | {
  status: 'inProgress';
  done: number;
  total: number;
} | {
  status: 'error';
} | {
  status: 'cancelled';
} | {
  status: 'done';
  lyrics: Lyrics;
};

function getRandomElement<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)]
}

const GENERATION_TIMEOUT_MS = 5000;

class Server {
  _app = express();
  _generationQueue: Promise<unknown> = Promise.resolve();
  _generationTimeouts: Map<string, NodeJS.Timeout> = new Map();
  _pendingGenerations: Map<string, Generation> = new Map();
  _pool: Pool;
  _waitingGenerations: Record<string, Generation> = {};

  constructor() {
    this._app.use(express.json());
    this._app.use(express.static('frontend/build'));
    if (NODE_ENV !== 'production') {
      this._app.use(cors());
    }

    this._app.get('/access_token_from_code', async (req, res) => {
      const { code } = req.query;
      if (typeof code !== 'string') {
        res.sendStatus(400);
        return;
      }

      const redirectUri = NODE_ENV === 'production' ? 'https://literalvisualiser.com' :  'http://localhost:8080';
      try {
        const { data: { access_token, expires_in, refresh_token } } = await axios.post(`https://accounts.spotify.com/api/token?client_id=${SPOTIFY_CLIENT_ID}&client_secret=${SPOTIFY_CLIENT_SECRET}&code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent(`${redirectUri}/post_message`)}`, null, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        res.json({
          accessToken: access_token,
          expiresIn: expires_in,
          refreshToken: refresh_token
        });
      } catch (error) {
        console.error('access_token error', {
          error
        });
        res.sendStatus(500);
        return;
      }
    });

    this._app.get('/access_token_from_refresh_token', async (req, res) => {
      const { refresh_token } = req.query;
      if (typeof refresh_token !== 'string') {
        res.sendStatus(400);
        return;
      }

      try {
        const { data: { access_token, expires_in } } = await axios.post(`https://accounts.spotify.com/api/token?client_id=${SPOTIFY_CLIENT_ID}&client_secret=${SPOTIFY_CLIENT_SECRET}&refresh_token=${refresh_token}&grant_type=refresh_token`, null, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        });
        res.json({
          accessToken: access_token,
          expiresIn: expires_in
        });
      } catch (error) {
        console.error('access_token error', {
          error
        });
        res.sendStatus(500);
        return;
      }
    });

    this._app.get('/generate/:trackId', async (req, res) => {
      try {
        const { trackId } = req.params;
        let lines: { startTimeMs: string; words: string; }[] = [];
        try {
          lines = (await axios.get(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&vocalRemoval=false`, {
            headers: {
              'App-Platform': 'WebPlayer',
              Authorization: `Bearer ${await this._getAccessToken()}`
            }
          })).data.lyrics.lines;
        } catch (error: any) {
          if (error.response?.status === 404) {
            res.sendStatus(422);
            return;
          }
        }
        // last lyric is always blank
        const slicedLines = lines.slice(0, -1);
        const generationId = v4();
        const uniqueWords = [...new Set(slicedLines.map(({ words }) => words))];
        const hasAnyUncachedResult = await this._pool.execute(`SELECT COUNT(DISTINCT(words)) FROM generations WHERE words IN (${new Array(uniqueWords.length).fill('?').join(',')})`, uniqueWords);
        const hasAnyUncached = (hasAnyUncachedResult[0] as RowDataPacket[])[0]['COUNT(DISTINCT(words))'] < uniqueWords.length;
        const setInProgress = () => {
          this._pendingGenerations.set(generationId, {
            status: 'inProgress',
            done: 0,
            total: lines.length
          });
        };
        if (hasAnyUncached) {
          const server = this;
          const generation: Generation = {
            get queuePosition() {
              return Object.values(server._waitingGenerations).indexOf(this) + 2; // 1 for index + 1 for current one inProgress
            },
            status: 'waiting'
          };
          this._waitingGenerations[generationId] = generation;
          this._pendingGenerations.set(generationId, generation);
        } else {
          setInProgress();
        }
        this._resetGenerationTimeout(generationId);
        res.json({
          generationId
        });

        const callback = async () => {
          const getGeneration = () => this._pendingGenerations.get(generationId);
          let uncachedIndex = -1;
          const pendingImageUrisByWords: Map<string, Promise<string[]>> = new Map();
          setInProgress();
          delete this._waitingGenerations[generationId];
          const lyrics = await Promise.all(slicedLines.map(async ({ startTimeMs, words }) => {
            if (getGeneration()?.status !== 'inProgress') {
              return;
            }

            let imageUri = 'data:image/jpeg;base64,';
            try {
              const existingResult = await this._pool.execute('SELECT id FROM generations WHERE words = ?', [words]);
              const existingRecords = existingResult[0] as RowDataPacket[];
              const pendingImageUris = pendingImageUrisByWords.get(words);
              if (pendingImageUris) {
                imageUri += getRandomElement(await pendingImageUris);
                if (getGeneration()?.status !== 'inProgress') {
                  return;
                }
              } else if (existingRecords.length > 0) {
                const randomRecord = getRandomElement(existingRecords);
                imageUri += await fs.promises.readFile(`images/${randomRecord.id}`, 'base64');
                if (getGeneration()?.status !== 'inProgress') {
                  return;
                }

              } else {
                uncachedIndex++;
                await new Promise((resolve) => setTimeout(resolve, Math.floor(uncachedIndex / 3) * 10000));
                if (getGeneration()?.status !== 'inProgress') {
                  return;
                }

                console.log('generating', {
                  words
                });
                const promise = axios.post(IMAGE_GEN_URL as string, {
                  prompt: words
                }) as Promise<{ data: { images: string[]; } }>;
                pendingImageUrisByWords.set(words, promise.then(({ data: { images } }) => images));
                const { data: { images } } = await promise;
                if (getGeneration()?.status !== 'inProgress') {
                  return;
                }
                console.log('generated', {
                  words
                });
                images.forEach(async (image) => {
                  const imageId = v4();
                  await fs.promises.writeFile(`images/${imageId}`, image, 'base64');
                  await this._pool.execute('INSERT INTO generations (id, words) VALUES (?, ?)', [imageId, words]);
                });
                imageUri += getRandomElement(images);
              }

              const generation = getGeneration();
              if (generation && generation.status === 'inProgress') {
                generation.done++;
              }
            } catch (error) {
              if (getGeneration()?.status !== 'inProgress') {
                return;
              }
              console.error('generation error', {
                error
              });
              this._pendingGenerations.set(generationId, {
                status: 'error',
              });
            }

            return {
              imageUri,
              startTimeMs: parseInt(startTimeMs, 10),
              words
            };
          }));
          if (this._pendingGenerations.get(generationId)?.status === 'inProgress') {
            this._pendingGenerations.set(generationId, {
              status: 'done',
              lyrics: lyrics as unknown as Lyrics
            });
          }
        }
        if (hasAnyUncached) {
          this._generationQueue = this._generationQueue.finally(callback);
        } else {
          callback();
        }
      } catch (error) {
        console.error('generation endpoint error', {
          error
        });
        if (!res.headersSent) {
          res.sendStatus(500);
        }
      }
    });

    this._app.get('/poll/:generationId', (req, res) => {
      const { generationId } = req.params;
      const generation = this._pendingGenerations.get(generationId);
      if (!generation) {
        res.sendStatus(404);
        return;
      }

      this._resetGenerationTimeout(generationId);
      res.json(generation);

      if (generation.status === 'done') {
        this._pendingGenerations.delete(generationId);
      }
    });

    this._app.get('/post_message', (req, res) => {
      res.sendFile(resolve(`${__dirname}/public/post_message.html`))
    });

    const [host, dbPort] = (DB_HOST ?? 'localhost').split(':');
    const parsedDbPort = parseInt(dbPort ?? '3306', 10);
    this._pool = createPool({
      database: DB_NAME ?? 'literal_visualiser',
      host,
      password: DB_PASS ?? '',
      port: parsedDbPort,
      user: DB_USER ?? 'root'
    });

    this._pool.execute(
      `
        CREATE TABLE IF NOT EXISTS generations (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          words TEXT NOT NULL,
          INDEX(words)
        );
      `.trim()
    ).then(() => {
      const port = parseInt(PORT ?? '8080', 10);
      const server = this._app.listen(port, () => {
        console.log('listening', {
          port: (server.address() as AddressInfo).port
        });
      });
    });
  }

  async _getAccessToken() {
    const cachedAccessToken = await get('access_token');
    if (!cachedAccessToken || cachedAccessToken.accessTokenExpirationTimestampMs < Date.now()) {
      const { data: { accessToken, accessTokenExpirationTimestampMs, isAnonymous } } = await axios.get('https://open.spotify.com/get_access_token', {
        headers: {
          'App-Platform': 'WebPlayer',
          Cookie: `sp_dc=${SPOTIFY_DC};`,
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Safari/537.36'
        }
      });
      if (isAnonymous) {
        throw 'token returned as isAnonymous';
      }
      await set('access_token', {
        accessToken,
        accessTokenExpirationTimestampMs
      });
      return accessToken;
    }

    return cachedAccessToken.accessToken;
  }

  _resetGenerationTimeout(generationId: string) {
    const timeout = this._generationTimeouts.get(generationId);
    if (typeof timeout !== 'undefined') {
      clearTimeout(timeout);
    }

    this._generationTimeouts.set(generationId, setTimeout(() => {
      console.log('generation timed out', {
        generationId
      });
      this._generationTimeouts.delete(generationId);
      this._pendingGenerations.delete(generationId);
      delete this._waitingGenerations[generationId];
    }, GENERATION_TIMEOUT_MS));
  }
}

export default new Server();
