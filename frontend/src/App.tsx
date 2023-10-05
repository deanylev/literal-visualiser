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

interface Props {}

interface State {
  accessDetails: AccessDetails | null;
  currentLyric: { imageUri: string; words: string; } | null;
  hideSuggestions: boolean;
  isError: boolean;
  lyricsDivKey: number;
  progress: number | null;
  queuePosition: number;
  search: string;
  searchDebounceTimeout: number | null;
  searchInFlight: boolean;
  songs: Song[];
}

const isDev = process.env.NODE_ENV === 'development';
const API_URL = isDev ? `http://${window.location.hostname}:8080` : '';
const REDIRECT_URI = isDev ? API_URL : 'https://literalvisualiser.com';

const SEARCH_DEBOUNCE_INTERVAL = 500;
const STORAGE_KEY_ACCESS_DETAILS = 'spotifyAccessDetails';

class App extends Component<Props, State> {
  autosuggestRef: RefObject<Autosuggest> = createRef();
  debouncePromise = Promise.resolve();
  deviceId: string | null = null;
  lyricsImageRef: RefObject<HTMLImageElement> = createRef();
  playingDeferred: {
    promise: Promise<void>;
    resolve: () => void;
  } | null = null;

  constructor(props: Props) {
    super(props);

    const accessDetailsString = localStorage.getItem(STORAGE_KEY_ACCESS_DETAILS);
    this.state = {
      accessDetails: accessDetailsString && JSON.parse(accessDetailsString),
      currentLyric: null,
      hideSuggestions: false,
      isError: false,
      lyricsDivKey: Date.now(),
      progress: null,
      queuePosition: -1,
      search: '',
      searchDebounceTimeout: null,
      searchInFlight: false,
      songs: []
    };

    const promise = new Promise<void>((resolve) => {
      this.playingDeferred = {
        promise,
        resolve
      };
    });

    this.handleLogout = this.handleLogout.bind(this);
    this.handleSearchChange = this.handleSearchChange.bind(this);
    this.handleSuggestionsFetchRequested = this.handleSuggestionsFetchRequested.bind(this);
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
    this.handleWindowResize = debounce(this.handleWindowResize.bind(this), 500);
  }

  async componentDidMount() {
    window.addEventListener('message', this.handleWindowMessage, false);
    window.addEventListener('resize', this.handleWindowResize, false);

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
      const response = await fetch(`https://api.spotify.com/v1/search?q=${trimmedSearch.replace(/\s/g, '+')}&type=track`, {
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
            id: string;
            name: string;
          }[];
        };
      };
      const songs: Song[] = items.map(({ album, artists, id, name }) => ({
        artists: artists.map(({ name }) => name).join(', '),
        id,
        title: name,
        thumbnailUrl: album.images[1].url
      }));
      this.setState({
        isError: false,
        songs
      });
    } catch (error) {
      console.error(error);
      this.setState({
        isError: true,
        songs: []
      });
    } finally {
      this.setState({
        searchInFlight: false
      });
    }
  }

  async generate({ id }: Song) {
    try {
      const generateResponse = await fetch(`${API_URL}/generate/${id}`);
      if (generateResponse.status === 422) {
        toast.error('Sorry, lyrics are not available for that song.');
        return;
      } else if (!generateResponse.ok) {
        this.setState({
          isError: true
        });
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
        const pollResponse = await fetch(`${API_URL}/poll/${generationId}`);
        if (!pollResponse.ok) {
          isError = true;
          this.setState({
            isError: true
          });
          return true;
        }

        const pollJson = await pollResponse.json();
        if (pollJson.status === 'waiting') {
          this.setState({
            queuePosition: pollJson.queuePosition
          });
        }
        if (pollJson.status === 'inProgress') {
          this.setState({
            progress: pollJson.done / pollJson.total,
            queuePosition: -1
          });
          return false;
        }

        if (pollJson.status === 'error') {
          isError = true;
          this.setState({
            isError: true
          });
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
        await new Promise<void>((resolve) => {
          window.addEventListener('focus', () => resolve(), {
            once: true
          });
        });
      }
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
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
    } catch {
      this.setState({
        isError: true
      });
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

    const response = await fetch(`${API_URL}/access_token_from_refresh_token?refresh_token=${accessDetails.refreshToken}`);
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

    const response = await fetch(`${API_URL}/access_token_from_code?code=${data.code}`);
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

  render() {
    const { accessDetails, currentLyric, hideSuggestions, isError, lyricsDivKey, progress, queuePosition, search, searchDebounceTimeout, searchInFlight, songs } = this.state;
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

    return (
      <div className="App">
        <Toaster />
        <div className="body">
          <div className="heading">Literal Visualiser</div>
          {isError && (
            <div className="message">Sorry, something went wrong</div>
          ) || currentLyric && (
            <div className="lyrics">
              <div key={lyricsDivKey} style={{ maxWidth: lyricsImage ? 0.8 * Math.min(lyricsImage.naturalWidth, lyricsImage.width) : 600 }}>
                {currentLyric.words}
              </div>
              <img ref={this.lyricsImageRef} src={currentLyric.imageUri} />
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
                    onSuggestionSelected={(event, data) => this.generate(data.suggestion)}
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
          Made by <a href="https://deanlevinson.com.au" rel="noreferrer" target="_blank">Dean Levinson</a> | <a href="https://github.com/deanylev/literal-visualiser" rel="noreferrer" target="_blank">Source</a>
        </div>
      </div>
    );
  }

  renderSuggestion({ artists, disabled, thumbnailUrl, title }: Song) {
    return (
      <>
        {!disabled && (
          <div className="poster">
            {thumbnailUrl && <img alt={`Poster for ${title}`} src={thumbnailUrl} />}
          </div>
        )}
        {artists ? ` ${artists} - ` : ''}{title}
      </>
    );
  }
}

export default App;
