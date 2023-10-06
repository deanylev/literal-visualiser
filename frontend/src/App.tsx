import { Component, FormEvent, RefObject, createRef } from 'react';

import debounce from 'lodash.debounce';
import Autosuggest, { ChangeEvent, SuggestionsFetchRequestedParams } from 'react-autosuggest';
import toast, { Toaster } from 'react-hot-toast';

import waitUntil from './util/waitUntil';

import './App.scss';

interface Song {
  artists: string;
  disabled?: boolean;
  id: string;
  spotifyLink?: string;
  thumbnailUrl: string | null;
  title: string;
}

type Lyrics = {
  imageUri: string;
  startTimeMs: number;
  words: string;
}[];

interface AccessDetails {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

interface OriginalConsole {
  // these method signatures are stolen from Console
  debug: (message: unknown, ...optionalParams: unknown[]) => void;
  error: (message: unknown, ...optionalParams: unknown[]) => void;
  info: (message: unknown, ...optionalParams: unknown[]) => void;
  log: (message: unknown, ...optionalParams: unknown[]) => void;
  warn: (message: unknown, ...optionalParams: unknown[]) => void;
}

interface Props {}

interface State {
  accessDetails: AccessDetails | null;
  currentLyric: { imageUri: string; words: string; } | null;
  hideSuggestions: boolean;
  isError: boolean;
  logs: { level: keyof OriginalConsole; message: string; data: unknown[] }[];
  lyricsDivKey: number;
  progress: number | null;
  queuePosition: number;
  search: string;
  searchDebounceTimeout: number | null;
  searchInFlight: boolean;
  selectedSong: Song | null;
  showLogs: boolean;
  songs: Song[];
}

const isDev = process.env.NODE_ENV === 'development';
const API_URL = isDev ? `http://${window.location.hostname}:8080` : '';
const REDIRECT_URI = isDev ? API_URL : 'https://literalvisualiser.com';

const SEARCH_DEBOUNCE_INTERVAL = 500;
const STORAGE_KEY_ACCESS_DETAILS = 'spotifyAccessDetails';

// allow 'Error' objects to be serialized to json
Object.defineProperty(Error.prototype, 'toJSON', {
  value() {
    return Object.getOwnPropertyNames(this).reduce((alt, key) => ({
      ...alt,
      [key]: this[key]
    }), {});
  },
  configurable: true,
  writable: true
});


class App extends Component<Props, State> {
  autosuggestRef: RefObject<Autosuggest> = createRef();
  debouncePromise = Promise.resolve();
  deviceId: string | null = null;
  logQueue = Promise.resolve();
  lyricsImageRef: RefObject<HTMLImageElement> = createRef();
  originalConsole: OriginalConsole = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn
  };
  playingDeferred: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;
  secretClicks = 0;

  constructor(props: Props) {
    super(props);

    const accessDetailsString = localStorage.getItem(STORAGE_KEY_ACCESS_DETAILS);
    this.state = {
      accessDetails: accessDetailsString && JSON.parse(accessDetailsString),
      currentLyric: null,
      hideSuggestions: false,
      isError: false,
      logs: [],
      lyricsDivKey: Date.now(),
      progress: null,
      queuePosition: -1,
      search: '',
      searchDebounceTimeout: null,
      searchInFlight: false,
      selectedSong: null,
      showLogs: false,
      songs: []
    };

    let promise: Promise<void>;
    promise = new Promise<void>((resolve) => {
      this.playingDeferred = {
        promise,
        resolve
      };
    });

    this.handleLogout = this.handleLogout.bind(this);
    this.handleSearchChange = this.handleSearchChange.bind(this);
    this.handleSecretClick = this.handleSecretClick.bind(this);
    this.handleSuggestionsFetchRequested = this.handleSuggestionsFetchRequested.bind(this);
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
    this.handleWindowResize = debounce(this.handleWindowResize.bind(this), 500);
  }

  async componentDidMount() {
    this.setPageTitle();

    window.addEventListener('message', this.handleWindowMessage, false);
    window.addEventListener('resize', this.handleWindowResize, false);

    Object.keys(this.originalConsole).forEach((level) => {
      const castLevel = level as keyof OriginalConsole;
      window.console[castLevel as keyof OriginalConsole] = (message: unknown, ...optionalParams: unknown[]) => {
        if (typeof message === 'string') {
          this.logAtLevel(castLevel, message, ...optionalParams);
        } else {
          this.logAtLevel(castLevel, '', message, ...optionalParams);
        }
      };
    });

    const accessToken = await this.getAccessToken();
    if (accessToken) {
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);

      if (!('onSpotifyWebPlaybackSDKReady' in window)) {
        let initialised = false;
        (window as any).onSpotifyWebPlaybackSDKReady = () => {
          if (initialised) {
            return;
          }

          initialised = true;

          const player = new (window as any).Spotify.Player({
            name: 'Literal Visualiser',
            getOAuthToken: (callback: (token: string) => void) => { callback(accessToken); }
          });

          // https://community.spotify.com/t5/Spotify-for-Developers/Web-Playback-SDK-Playing-song-directly-in-browser-issues-IOS/m-p/5539654/highlight/true#M8798
          window.addEventListener('click', () => player.activateElement(), {
            once: true
          });

          player.on('initialization_error', console.error);
          player.on('authentication_error', console.error);
          player.on('account_error', console.error);
          player.on('playback_error', console.error);

          let playing = false;
          player.on('player_state_changed', (state: any) => {
            console.log('player_stated_changed', {
              state
            });

            if (!playing && !state.paused) {
              this.playingDeferred?.resolve();
              playing = true;
            }
          });

          player.on('ready', (data: any) => {
            this.deviceId = data.device_id;
          });

          player.connect();
        };
      }
    }
  }

  componentWillUnmount() {
    window.removeEventListener('message', this.handleWindowMessage, false);
    window.removeEventListener('resize', this.handleWindowResize, false);

    Object.keys(this.originalConsole).forEach((level) => {
      const castLevel = level as keyof OriginalConsole;
      console[castLevel] = this.originalConsole[castLevel];
    });
  }

  async _handleSuggestionsFetchRequested({ reason, value }: SuggestionsFetchRequestedParams) {
    const { songs } = this.state;
    const accessToken = await this.getAccessToken();

    if (reason === 'suggestion-selected') {
      return;
    }

    if (reason === 'input-focused' && songs.length > 0) {
      this.setState({
        hideSuggestions: false,
      });
      return;
    }

    const trimmedSearch = value.trim().toLowerCase();
    if (!trimmedSearch) {
      this.setState({
        songs: []
      });
      return;
    }

    this.setState({
      hideSuggestions: false,
      searchInFlight: true
    });

    try {
      const response = await this.fetch(`https://api.spotify.com/v1/search?q=${trimmedSearch.replace(/\s/g, '+')}&type=track`, {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      });
      const { tracks: { items } } = await response.json() as {
        tracks: {
          items: {
            album: {
              images: {
                url: string;
              }[];
            };
            artists: {
              name: string;
            }[];
            external_urls: {
              spotify: string;
            };
            id: string;
            name: string;
          }[];
        };
      };
      const songs: Song[] = items.map(({ album, artists, external_urls, id, name }) => ({
        artists: artists.map(({ name }) => name).join(', '),
        id,
        spotifyLink: external_urls.spotify,
        title: name,
        thumbnailUrl: album.images[1].url
      }));
      this.setState({
        isError: false,
        songs
      });
    } catch (error) {
      console.error(error);
      this.setError();
    } finally {
      this.setState({
        searchInFlight: false
      });
    }
  }

  async fetch(...args: Parameters<typeof fetch>) {
    let response: Response | null = null;
    try {
      response = await fetch(...args);
      return response;
    } catch (error) {
      console.error('fetch error', {
        args,
        response,
        error,
      });
      throw error;
    }
  }

  async generate(id: string) {
    try {
      const generateResponse = await this.fetch(`${API_URL}/generate/${id}`);
      if (generateResponse.status === 422) {
        toast.error('Sorry, lyrics are not available for that song.');
        return;
      } else if (!generateResponse.ok) {
        this.setError();
        return;
      }

      this.setState({
        progress: 0
      });

      const { generationId } = await generateResponse.json();
      let lyrics: Lyrics = [];
      const accessToken = await this.getAccessToken();
      let isError = false;
      await waitUntil(async () => {
        const pollResponse = await this.fetch(`${API_URL}/poll/${generationId}`);
        if (!pollResponse.ok) {
          isError = true;
          this.setError();
          return true;
        }

        const pollJson = await pollResponse.json();
        if (pollJson.status === 'waiting') {
          const { queuePosition } = pollJson;
          this.setState({
            queuePosition
          });
          this.setPageTitle(`#${queuePosition}`);
        }
        if (pollJson.status === 'inProgress') {
          const progress = pollJson.done / pollJson.total;
          this.setState({
            progress,
            queuePosition: -1
          });
          this.setPageTitle(`${(progress * 100).toFixed(2)}%`);
          return false;
        }

        if (pollJson.status === 'error') {
          isError = true;
          this.setError();
          return true;
        }

        if (pollJson.status === 'done') {
          lyrics = pollJson.lyrics;
          return true;
        }
      }, 1000); // 1 poll per second, no timeout
      if (isError) {
        return;
      }
      this.setState({
        progress: 1
      });
      if (!document.hasFocus()) {
        this.setPageTitle('Ready to Play');
        await new Promise<void>((resolve) => {
          window.addEventListener('focus', () => resolve(), {
            once: true
          });
        });
      }
      this.setPageTitle('Playing');
      await this.fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
        body: JSON.stringify({
          uris: [`spotify:track:${id}`]
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        method: 'PUT'
      });
      await this.playingDeferred?.promise;
      lyrics.forEach(({ imageUri, startTimeMs, words }) => {
        setTimeout(() => {
          this.setState({
            currentLyric: { imageUri, words }
          });
        }, startTimeMs);
      });
    } catch (error) {
      console.error(error);
      this.setError();
    }
  }

  async getAccessToken() {
    const { accessDetails } = this.state;
    if (!accessDetails) {
      return null;
    }

    if (accessDetails.expiresAt > Date.now()) {
      return accessDetails.accessToken;
    }

    const response = await this.fetch(`${API_URL}/access_token_from_refresh_token?refresh_token=${accessDetails.refreshToken}`);
    const json = await response.json();
    const newAccessDetails = { ...accessDetails };
    newAccessDetails.accessToken = json.accessToken;
    newAccessDetails.expiresAt = Date.now() + (json.expiresIn * 1000);
    localStorage.setItem(STORAGE_KEY_ACCESS_DETAILS, JSON.stringify(newAccessDetails));
    window.location.reload(); // TODO be more graceful
    return newAccessDetails.accessToken;
  }

  handleAuth() {
    const scopes = [
      'streaming',
      'user-modify-playback-state'
    ];
    const width = 800;
    const height = 800;
    // https://stackoverflow.com/a/32261263
    const top = (window.top?.innerHeight ?? 0) / 2 + (window.top?.screenY ?? 0) - (height / 2);
    const left = (window.top?.outerWidth ?? 0) / 2 + (window.top?.screenX ?? 0) - (width / 2);
    window.open(
      `https://accounts.spotify.com/authorize?client_id=e7494558c72744c284d6165e89dd172d&redirect_uri=${REDIRECT_URI}/post_message&scope=${scopes.join('%20')}&response_type=code&show_dialog=true`,
      'literal-visualiser-auth',
      `scrollbars=no,resizable=no,status=no,location=no,toolbar=no,menubar=no,width=${width},height=${height},top=${top},left=${left}`
    );
  }

  handleLogout() {
    if (!window.confirm('Are you sure?')) {
      return;
    }

    localStorage.removeItem(STORAGE_KEY_ACCESS_DETAILS);
    window.location.reload();
  }

  handleSearchChange(event: FormEvent<HTMLElement>, { newValue }: ChangeEvent) {
    this.setState({
      search: newValue
    });
  }

  handleSecretClick() {
    this.secretClicks++;
    if (this.secretClicks >= 10) {
      this.setState({
        showLogs: true
      });
    }
  }

  handleSuggestionsFetchRequested(params: SuggestionsFetchRequestedParams) {
    this.debouncePromise = this.debouncePromise.then(async () => {
      const { searchDebounceTimeout } = this.state;
      if (searchDebounceTimeout !== null) {
        clearTimeout(searchDebounceTimeout);
        await new Promise<void>((resolve) => {
          this.setState({
            searchDebounceTimeout: null
          }, resolve);
        });
      }

      await new Promise<void>((resolve) => {
        this.setState({
          searchDebounceTimeout: window.setTimeout(() => {
            this._handleSuggestionsFetchRequested(params);
            this.setState({
              searchDebounceTimeout: null
            });
          }, SEARCH_DEBOUNCE_INTERVAL)
        }, resolve);
      });
    });
  }

  async handleWindowMessage({ data }: MessageEvent) {
    if (!(data && typeof data === 'object' && data.type === 'code' && typeof data.code === 'string')) {
      return;
    }

    const response = await this.fetch(`${API_URL}/access_token_from_code?code=${data.code}`);
    const json = await response.json();
    localStorage.setItem(STORAGE_KEY_ACCESS_DETAILS, JSON.stringify({
      accessToken: json.accessToken,
      expiresAt: Date.now() + (json.expiresIn * 1000),
      refreshToken: json.refreshToken
    }));
    window.location.reload();
  }

  handleWindowResize() {
    this.setState({
      lyricsDivKey: Date.now()
    });
  }

  logAtLevel(level: keyof OriginalConsole, message: string, ...data: unknown[]) {
    this.logQueue = this.logQueue.then(() => new Promise((resolve) => {
      this.originalConsole[level](`[${level}]`, message, ...data);
      this.setState({
        logs: [
          ...this.state.logs,
          {
            level,
            message,
            data
          }
        ]
      }, resolve);
    }))
  }

  render() {
    const {
      accessDetails,
      currentLyric,
      hideSuggestions,
      isError,
      logs,
      lyricsDivKey,
      progress,
      queuePosition,
      search,
      searchDebounceTimeout,
      searchInFlight,
      selectedSong,
      showLogs,
      songs
    } = this.state;
    const loadingSuggestion: Song = {
      artists: '',
      disabled: true,
      id: 'loading',
      thumbnailUrl: null,
      title: 'Loading...'
    };
    const noResultsSuggestion: Song = {
      artists: '',
      disabled: true,
      id: 'no-results',
      thumbnailUrl: null,
      title: 'No Results'
    };
    const getSuggestions = () => {
      if (searchInFlight) {
        return [loadingSuggestion];
      }

      if (!search.trim() || searchDebounceTimeout !== null) {
        return [];
      }

      if (songs.length === 0) {
        return [noResultsSuggestion];
      }

      if (hideSuggestions) {
        return [];
      }

      return songs;
    };
    const suggestions = getSuggestions();
    const disabledSuggestion = !!suggestions[0]?.disabled;
    const lyricsImage = this.lyricsImageRef.current;

    if (showLogs) {
      return (
        <div className="App">
          <table>
            <thead>
              <tr>
                <th>Level</th>
                <th>Message</th>
                <th>Data</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(({ data, level, message }, index) => (
                <tr key={index}>
                  <td>{level}</td>
                  <td>{message}</td>
                  <td>{JSON.stringify(data)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <div className="App">
        <Toaster />
        <div className="body">
          <div className="heading">Literal Visualiser</div>
          {isError && (
            <div className="message">Sorry, something went wrong</div>
          ) || currentLyric && (
            <div className="playback">
              <div className="lyrics" key={lyricsDivKey} style={{ maxWidth: lyricsImage ? 0.8 * Math.min(lyricsImage.naturalWidth, lyricsImage.width) : 600 }}>
                {currentLyric.words}
              </div>
              <img ref={this.lyricsImageRef} src={currentLyric.imageUri} />
              <div className="metadata">
                {selectedSong?.thumbnailUrl && <img alt={`Poster for ${selectedSong.title ?? 'Unknown'}`} src={selectedSong?.thumbnailUrl} />}
                {selectedSong?.artists ? ` ${selectedSong.artists} - ` : ''}{selectedSong?.title ?? 'Unknown'}
              </div>
            </div>
          ) || queuePosition >= 2 && (
            <div className="message">Waiting... #{queuePosition} in Queue</div>
          ) || progress !== null && (
            <div className="message">{progress === 1 ? 'Playing...' : `Generating... ${(progress * 100).toFixed(2)}%`}</div>
          )|| (
            <div className="setup">
              {accessDetails ? (
                <>
                  <Autosuggest
                    containerProps={{
                      'data-disabled': disabledSuggestion.toString()
                    } as Autosuggest.ContainerProps}
                    focusInputOnSuggestionClick={false}
                    getSuggestionValue={(suggestion) => disabledSuggestion ? search : suggestion.title}
                    inputProps={{
                      onChange: this.handleSearchChange,
                      placeholder: 'Search for a song...',
                      value: search
                    }}
                    onSuggestionsFetchRequested={this.handleSuggestionsFetchRequested}
                    onSuggestionSelected={(event, { suggestion }) => {
                      if ((event.target as HTMLElement).tagName === 'A') {
                        return;
                      }

                      this.setState({
                        selectedSong: suggestion
                      });
                      this.generate(suggestion.id);
                    }}
                    ref={this.autosuggestRef}
                    renderSuggestion={this.renderSuggestion}
                    suggestions={suggestions}
                  />
                  <button onClick={this.handleLogout}>Log Out of Spotify</button>
                </>
              ) : (
                <button onClick={this.handleAuth}>Link Spotify Account</button>
              )}
            </div>
          )}
        </div>
        <div className="footer">
          <span onClick={this.handleSecretClick}>Made</span> by <a href="https://deanlevinson.com.au" rel="noreferrer" target="_blank">Dean Levinson</a> | <a href="https://github.com/deanylev/literal-visualiser" rel="noreferrer" target="_blank">Source</a>
        </div>
      </div>
    );
  }

  renderSuggestion({ artists, disabled, spotifyLink, thumbnailUrl, title }: Song) {
    return (
      <>
        <div className="info">
          {!disabled && (
            <div className="poster">
              {thumbnailUrl && <img alt={`Poster for ${title}`} src={thumbnailUrl} />}
            </div>
          )}
          {artists ? ` ${artists} - ` : ''}{title}
        </div>
        {spotifyLink && (
          <a className="spotifyLink" href={spotifyLink} rel="noreferrer" target="_blank">
            Listen on <img src="spotify-logo.png" />
          </a>
        )}
      </>
    );
  }

  setError() {
    this.setState({
      isError: true
    });
    this.setPageTitle('Error');
  }

  setPageTitle(title?: string) {
    document.title = `Literal Visualiser ${title ? `- ${title}` : ''}`;
  }
}

export default App;
