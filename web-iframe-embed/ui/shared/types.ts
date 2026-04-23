export type Placement =
  | 'operator'
  | 'automation'
  | 'main-right'
  | 'voice-left-top'
  | 'voice-right-top';

export type StreamType = 'hls' | 'file';

export interface PageConfigResponse {
  pageId: string;
  placement: Placement;
  url: string;
}

export type RenderConfig =
  | { mode: 'empty' }
  | { mode: 'invalid'; src: string }
  | { mode: 'iframe'; src: string }
  | {
    mode: 'video';
    src: string;
    streamType: StreamType;
    autoplay: true;
    muted: true;
    controls: true;
    playsInline: true;
  };
