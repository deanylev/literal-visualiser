import { Component, FormEvent, RefObject, createRef } from 'react';

import debounce from 'lodash.debounce';
import Autosuggest, { ChangeEvent, SuggestionsFetchRequestedParams } from 'react-autosuggest';
import toast, { Toaster } from 'react-hot-toast';

import './types/spotify-web-playback-sdk'
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

interface Props {}

interface State {
  accessDetails: AccessDetails | null;
  currentLyricIndex: number;
  hideSuggestions: boolean;
  isError: boolean;
  lyricsDivKey: number;
  pauseOnBlur: boolean;
  progress: number | null;
  queuePosition: number;
  search: string;
  searchDebounceTimeout: number | null;
  searchInFlight: boolean;
  selectedSong: Song | null;
  songs: Song[];
}

const isDev = process.env.NODE_ENV === 'development';
const API_URL = isDev ? `http://${window.location.hostname}:8080` : '';
const REDIRECT_URI = isDev ? API_URL : 'https://literalvisualiser.com';

const SEARCH_DEBOUNCE_INTERVAL = 500;
const STORAGE_KEY_ACCESS_DETAILS = 'spotifyAccessDetails';
const STORAGE_KEY_PAUSE_ON_BLUR = 'pauseOnBlur';

class App extends Component<Props, State> {
  autosuggestRef: RefObject<Autosuggest> = createRef();
  debouncePromise = Promise.resolve();
  deviceId: string | null = null;
  lyrics: Lyrics = [];
  lyricsImageRef: RefObject<HTMLImageElement> = createRef();
  player: Spotify.Player | null = null;

  constructor(props: Props) {
    super(props);

    const accessDetailsString = localStorage.getItem(STORAGE_KEY_ACCESS_DETAILS);
    this.state = {
      accessDetails: accessDetailsString && JSON.parse(accessDetailsString),
      currentLyricIndex: -1,
      hideSuggestions: false,
      isError: false,
      lyricsDivKey: Date.now(),
      pauseOnBlur: localStorage.getItem(STORAGE_KEY_PAUSE_ON_BLUR) !== 'false',
      progress: null,
      queuePosition: -1,
      search: '',
      searchDebounceTimeout: null,
      searchInFlight: false,
      selectedSong: null,
      songs: []
    };

    this.handleLogout = this.handleLogout.bind(this);
    this.handleSearchChange = this.handleSearchChange.bind(this);
    this.handleSuggestionsFetchRequested = this.handleSuggestionsFetchRequested.bind(this);
    this.handleWindowMessage = this.handleWindowMessage.bind(this);
    this.handleWindowResize = debounce(this.handleWindowResize.bind(this), 500);
  }

  async componentDidMount() {
    this.setPageTitle();

    window.addEventListener('message', this.handleWindowMessage, false);
    window.addEventListener('resize', this.handleWindowResize, false);

    const accessToken = await this.getAccessToken();
    if (accessToken) {
      const script = document.createElement('script');
      script.src = 'https://sdk.scdn.co/spotify-player.js';
      script.async = true;
      document.body.appendChild(script);

      if (typeof window.onSpotifyWebPlaybackSDKReady !== 'function') {
        let initialised = false;
        window.onSpotifyWebPlaybackSDKReady = () => {
          if (initialised) {
            return;
          }

          initialised = true;

          this.player = new window.Spotify.Player({
            name: 'Literal Visualiser',
            getOAuthToken: (callback) => {
              callback(accessToken);
            }
          });

          // https://community.spotify.com/t5/Spotify-for-Developers/Web-Playback-SDK-Playing-song-directly-in-browser-issues-IOS/m-p/5539654/highlight/true#M8798
          window.addEventListener('click', () => this.player?.activateElement(), {
            once: true
          });

          this.player.on('initialization_error', console.error);
          this.player.on('authentication_error', console.error);
          this.player.on('account_error', console.error);
          this.player.on('playback_error', console.error);
          this.player.on('ready', (data: any) => {
            this.deviceId = data.device_id;
          });

          this.player.connect();
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

  async generate(id: string) {
    try {
      const generateResponse = await fetch(`${API_URL}/generate/${id}`);
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
        const pollResponse = await fetch(`${API_URL}/poll/${generationId}`);
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
        this.setPageTitle('Ready');
        await new Promise<void>((resolve) => {
          window.addEventListener('focus', () => resolve(), {
            once: true
          });
        });
      }
      this.setPageTitle('Playing');
      await fetch(`https://api.spotify.com/v1/me/player/play?device_id=${this.deviceId}`, {
        body: JSON.stringify({
          uris: [`spotify:track:${id}`]
        }),
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        method: 'PUT'
      });
      let paused = false;
      let pausedOnce = false;
      // let lyricTimeouts: number[] = [];
      this.player?.on('player_state_changed', (state: any) => {
        console.log('player_stated_changed', {
          state
        });

        paused = !state || state.paused;

        // if (paused) {
        //   if (lyricTimeouts.length > 0) {
        //     pausedOnce = true;
        //     toast.success('Paused!');
        //     this.setPageTitle('Paused');
        //     lyricTimeouts.forEach((timeout) => {
        //       clearTimeout(timeout);
        //     });
        //     lyricTimeouts = [];
        //   }
        // } else if (lyricTimeouts.length === 0) {
        //   const { position } = state;
        //   if (pausedOnce) {
        //     toast.success('Playing!');
        //     this.setPageTitle('Playing');
        //   }
        //   lyricTimeouts = lyrics.filter(({ startTimeMs }) => startTimeMs > position).map(({ imageUri, startTimeMs, words }) => {
        //     return window.setTimeout(() => {
        //       this.setState({
        //         currentLyric: { imageUri, words }
        //       });
        //     }, startTimeMs - position)
        //   });
        // }
      });
      this.lyrics = lyrics;
      this.setState({
        currentLyricIndex: 0
      });
      if (this.state.pauseOnBlur) {
        let pausedByOnBlur = false;
        window.addEventListener('blur', () => {
          if (!paused) {
            this.player?.pause();
            pausedByOnBlur = true;
          }
        });
        window.addEventListener('focus', () => {
          if (pausedByOnBlur) {
            pausedByOnBlur = false;
            this.player?.resume();
          }
        });
      }
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
      'streaming'
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
    const {
      accessDetails,
      currentLyricIndex,
      hideSuggestions,
      isError,
      lyricsDivKey,
      pauseOnBlur,
      progress,
      queuePosition,
      search,
      searchDebounceTimeout,
      searchInFlight,
      selectedSong,
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

    return (
      <div className="App">
        <Toaster />
        <div className="body">
          <div className="heading">Literal Visualiser</div>
          {isError && (
            <div className="message">Sorry, something went wrong</div>
          ) || currentLyricIndex !== -1 && (
            <button className="playback" onClick={() => {
              const next = currentLyricIndex + 1;
              if (next >= this.lyrics.length) {
                return;
              }
              this.setState({
                currentLyricIndex: next
              });
            }}>
              <div className="lyrics" key={lyricsDivKey} style={{ maxWidth: lyricsImage ? 0.8 * Math.min(lyricsImage.naturalWidth, lyricsImage.width) : 600 }}>
                Click to see the next image!
              </div>
              <img ref={this.lyricsImageRef} src={this.lyrics[currentLyricIndex].imageUri} />
              <div className="metadata">
                {selectedSong?.thumbnailUrl && <img alt={`Poster for ${selectedSong.title ?? 'Unknown'}`} src={selectedSong?.thumbnailUrl} />}
                {selectedSong?.artists ? ` ${selectedSong.artists} - ` : ''}{selectedSong?.title ?? 'Unknown'}
              </div>
            </button>
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
                      const { tagName } = event.target as HTMLElement;
                      if (tagName === 'A' || tagName === 'IMG') {
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
                  <label>
                    Pause When Tab Loses Focus?
                    <input checked={pauseOnBlur} onChange={(event) => this.togglePauseOnBlur()} type="checkbox" />
                  </label>
                  <button onClick={this.handleLogout}>Log Out of Spotify</button>
                </>
              ) : (
                <button onClick={this.handleAuth}>Link Spotify Account</button>
              )}
            </div>
          )}
        </div>
        <div className="footer">
          Made by <a href="https://deanlevinson.com.au" rel="noreferrer" target="_blank">Dean Levinson</a>
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

  togglePauseOnBlur() {
    const pauseOnBlur = !this.state.pauseOnBlur;
    this.setState({
      pauseOnBlur
    });
    localStorage.setItem(STORAGE_KEY_PAUSE_ON_BLUR, pauseOnBlur.toString());
  }
}

export default App;
