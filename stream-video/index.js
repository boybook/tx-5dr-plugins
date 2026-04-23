/**
 * TX-5DR Stream Video Plugin
 * Display custom streaming video in iframe panel
 */

export default {
  name: 'stream-video',
  version: '1.1.0',
  type: 'utility',
  instanceScope: 'operator',
  description: 'Display custom streaming video',

  settings: {
    streamUrl: {
      type: 'string',
      default: '',
      label: 'streamUrl',
      description: 'streamUrlDesc',
      scope: 'operator',
    },
    streamType: {
      type: 'string',
      default: 'hls',
      label: 'streamType',
      options: [
        { label: 'HLS (.m3u8)', value: 'hls' },
        { label: 'MP4', value: 'mp4' },
        { label: 'WebRTC', value: 'webrtc' },
      ],
      scope: 'operator',
    },
  },

  panels: [
    {
      id: 'stream-viewer',
      title: 'streamViewerPanel',
      component: 'iframe',
      pageId: 'stream-viewer',
      width: 'full',
    },
  ],

  ui: {
    dir: 'ui',
    pages: [
      { id: 'stream-viewer', title: 'Stream Viewer', entry: 'stream-viewer.html' },
    ],
  },

  onLoad(ctx) {
    ctx.ui.registerPageHandler({
      onMessage(pageId, action, data, requestContext) {
        switch (action) {
          case 'getConfig':
            return {
              streamUrl: ctx.config.streamUrl || '',
              streamType: ctx.config.streamType || 'hls',
            };
          default:
            throw new Error('Unknown action: ' + action);
        }
      },
    });
  },
};