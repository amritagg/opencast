/*
 * Licensed to The Apereo Foundation under one or more contributor license
 * agreements. See the NOTICE file distributed with this work for additional
 * information regarding copyright ownership.
 *
 *
 * The Apereo Foundation licenses this file to you under the Educational
 * Community License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of the License
 * at:
 *
 *   http://opensource.org/licenses/ecl2.txt
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.  See the
 * License for the specific language governing permissions and limitations under
 * the License.
 *
 */
import { translate } from 'paella-core';

const g_streamTypes = [
  {
    enabled: true,
    streamType: 'mp4',
    conditions: {
      mimetype: 'video/mp4'
    },
    getSourceData: (track) => {
      const src = track.url;
      const mimetype = track.mimetype;
      const resolution = track.video?.resolution || '1x1';
      const resData = /(\d+)x(\d+)/.exec(resolution);
      const res = {
        w: 0,
        h: 0
      };

      if (resData) {
        res.w = resData[1];
        res.h = resData[2];
      }

      return { src, mimetype, res };
    }
  },
  {
    enabled: true,
    streamType: 'hls',
    conditions: {
      mimetype: 'application/x-mpegURL',
      live: false
    },
    getSourceData: (track) => {
      const src = track.url;
      const mimetype = track.mimetype;
      const master = track.master;
      return { src, mimetype, master };
    }
  },
  {
    enabled: true,
    streamType: 'hlsLive',
    conditions: {
      mimetype: 'application/x-mpegURL',
      live: true
    },
    getSourceData: (track) => {
      const src = track.url;
      const mimetype = track.mimetype;
      return { src, mimetype };
    }
  }
];

function getStreamType(track) {
  const result = g_streamTypes.find(typeData => {
    let match = typeData.enabled;
    for (const condition in typeData.conditions) {
      if (!match) {
        break;
      }
      const value = typeData.conditions[condition];
      match = match && track[condition] == value;
    }
    return match;
  });
  return result;
}

function getSourceData(track, config) {
  let data = null;
  // Get substring of type before slash
  const type = track.type.split('/')[0];
  if (type) {
    const streamType = getStreamType(track, config);
    if (streamType) {
      data = {
        source: streamType.getSourceData(track, config),
        type: streamType.streamType,
        content: type
      };
    }
  }
  return data;
}

function getMetadata(episode) {
  const { duration, title, language, series, seriestitle, subjects, license, type } = episode.mediapackage;
  const startDate = new Date(episode.dcCreated);
  const presenters = episode?.mediapackage?.creators?.creator
    ? (Array.isArray(episode?.mediapackage?.creators?.creator)
      ? episode?.mediapackage?.creators?.creator
      : [episode?.mediapackage?.creators?.creator])
    : [];
  const contributors = episode?.mediapackage?.contributors?.contributor
    ? (Array.isArray(episode.mediapackage.contributors.contributor)
      ? episode.mediapackage.contributors.contributor
      : [episode.mediapackage.contributors.contributor])
    : [];

  const result = {
    title,
    subject: subjects?.subject,
    description: episode?.dcDescription,
    language,
    rights: episode?.dcRightsHolder,
    license,
    series,
    seriestitle,
    presenters,
    contributors,
    startDate,
    duration: duration / 1000,
    location: episode?.dcSpatial,
    UID: episode?.id,
    type,
    opencast: {episode}
  };

  return result;
}

function mergeSources(sources, config) {
  const streams = [];
  // Does the sources contain any flavour compatible with the main audio content?
  let audioContent = null;
  sources.find(sourceData => {
    const { content } = sourceData;
    if (content === config.mainAudioContent) {
      audioContent = config.mainAudioContent;
      return true;
    }
    else {
      audioContent = content;
    }
  });

  sources.forEach(sourceData => {
    const { content, type, source } = sourceData;
    let stream = streams.find(s => s.content === content);
    if (!stream) {
      stream = {
        sources: {},
        content: content
      };

      if (content === audioContent) {
        stream.role = 'mainAudio';
      }

      streams.push(stream);
    }

    stream.sources[type] = stream.sources[type] || [];
    stream.sources[type].push(source);
  });
  return streams;
}

function getStreams(episode, config) {
  let { track } = episode.mediapackage.media;
  if (!Array.isArray(track)) {
    track = [track];
  }

  let sources = [];

  track.forEach(track => {
    const sourceData = getSourceData(track, config);
    sourceData && sources.push(sourceData);
  });

  const hasMaster = sources.find((x)=> x.type == 'hls' && x.source.master == true);
  if (hasMaster) {
    sources = sources.filter((x)=> x.type == 'hls' ? x.source.master == true : true);
  }
  const streams = mergeSources(sources, config);
  return streams;
}

function processSegments(episode, manifest) {
  const { segments } = episode;
  if (segments) {
    manifest.transcriptions = manifest.transcriptions || [];
    if (!Array.isArray(segments.segment)) {
      segments.segment = [segments.segment];
    }
    segments.segment.forEach(({ index, previews, text, time, duration}) => {
      manifest.transcriptions.push({
        index,
        preview: previews?.preview?.$,
        text,
        time,
        duration
      });
    });
  }
}

export function getVideoPreview(mediapackage, config) {
  const { attachments } = mediapackage;
  let videoPreview = null;

  let attachment = attachments?.attachment || [];
  if (!Array.isArray(attachment)) {
    attachment = [attachment];
  }

  const videoPreviewAttachments = config.videoPreviewAttachments || [
    'presenter/player+preview',
    'presentation/player+preview'
  ];
  attachment.forEach(att => {
    videoPreviewAttachments.some(validAttachment => {
      if (validAttachment === att.type) {
        videoPreview = att.url;
      }
      return videoPreview !== null;
    });
  });
  // Get first preview if no predefined was found
  if (videoPreview === null) {
    const firstPreviewAttachment = attachment.find(att => {
      return att.type.split('/').pop() === 'player+preview';
    });
    videoPreview = firstPreviewAttachment?.url ?? null;
  }

  return videoPreview;
}

function processAttachments(episode, manifest, config) {
  const { attachments } = episode.mediapackage;
  const previewImages = [];
  let videoPreview = null;

  let attachment = attachments?.attachment || [];
  if (!Array.isArray(attachment)) {
    attachment = [attachment];
  }

  const previewAttachment = config.previewAttachment || 'presentation/segment+preview';
  attachment.forEach(att => {
    const timeRE = /time=T(\d+):(\d+):(\d+)/.exec(att.ref);
    if (att.type === previewAttachment && timeRE) {
      const h = Number(timeRE[1]) * 60 * 60;
      const m = Number(timeRE[2]) * 60;
      const s = Number(timeRE[3]);
      const t = h + m + s;
      previewImages.push({
        mimetype: att.mimetype,
        url: att.url,
        thumb: att.url,
        id: `frame_${t}`,
        time: t
      });
    }
    else {
      videoPreview = getVideoPreview(episode.mediapackage, config);
    }
  });

  if (previewImages.length > 0) {
    manifest.frameList = previewImages;
  }

  if (videoPreview) {
    manifest.metadata = manifest.metadata || {};
    manifest.metadata.preview = videoPreview;
  }
}

function readCaptions(potentialNewCaptions, captions) {
  potentialNewCaptions.forEach((potentialCaption) => {
    try {
      let captions_regex = /^captions\/([^+]+)(\+(.+))?/g;
      let captions_match = captions_regex.exec(potentialCaption.type);

      if (captions_match) {
        // Fallback for captions which use the old flavor style, e.g. "captions/vtt+en"
        let captions_lang = captions_match[3];
        let captions_generated = '';
        let captions_closed = '';
        const captions_subtype = captions_match[1];

        if (potentialCaption.tags && potentialCaption.tags.tag) {
          if (!(potentialCaption.tags.tag instanceof Array)) {
            potentialCaption.tags.tag = [potentialCaption.tags.tag];
          }
          potentialCaption.tags.tag.forEach((tag)=>{
            if (tag.startsWith('lang:')){
              captions_lang = tag.substring('lang:'.length);
            }
            if (tag.startsWith('generator-type:') && tag.substring('generator-type:'.length) === 'auto') {
              captions_generated = ' (' + translate('automatically generated') + ')';
            }
            if (tag.startsWith('type:') && tag.substring('type:'.length) === 'closed-caption') {
              captions_closed = '[CC] ';
            }
          });
        }

        let captions_format = potentialCaption.url.split('.').pop();
        // Backwards support for 'captions/dfxp' flavored xml files
        if (captions_subtype === 'dfxp' && captions_format === 'xml') {
          captions_format = captions_subtype;
        }

        let captions_description = translate('Undefined caption');
        if (captions_lang) {
          let languageNames = new Intl.DisplayNames([window.navigator.language], {type: 'language'});
          let captions_language_name = languageNames.of(captions_lang) || translate('Unknown language');
          captions_description = captions_closed + captions_language_name + captions_generated;
        }

        captions.push({
          id: potentialCaption.id,
          lang: captions_lang,
          text: captions_description,
          url: potentialCaption.url,
          format: captions_format
        });
      }
    }
    catch (err) {/**/}
  });
}

function getCaptions(episode) {
  var captions = [];

  var attachments = episode.mediapackage.attachments.attachment;
  var tracks = episode.mediapackage.media.track;
  if (!(attachments instanceof Array)) { attachments = attachments ? [attachments] : []; }
  if (!(tracks instanceof Array)) { tracks = tracks ? [tracks] : []; }

  // Read the attachments
  readCaptions(attachments, captions);

  // Read the tracks
  readCaptions(tracks, captions);

  return captions;
}

export function episodeToManifest(ocResponse, config) {
  const searchResults = ocResponse['search-results'];
  if (searchResults?.total === 1) {
    const episode = searchResults.result;
    const metadata = getMetadata(episode, config);
    const streams = getStreams(episode, config);
    const captions = getCaptions(episode, config);

    const result = {
      metadata,
      streams,
      captions
    };

    processAttachments(episode, result, config);
    processSegments(episode, result, config);



    return result;
  }
  else {
    return null;
  }
}

export default class EpisodeConversor {
  constructor(episodeJson, config = {}) {
    this._data = episodeToManifest(episodeJson, config);
  }

  get data() {
    return this._data;
  }
}
