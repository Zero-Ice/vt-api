import { debug, Videos, youtube } from '../../../modules';
import type { LiveStreamingDetails, VideoResource } from '../../../modules/types/youtube';
import database from '../../database-managers/youtube';
import type { VideoId, YoutubeVideoObject } from './types';

const ONE_HOUR = 36E5;
const logger = debug('api:youtube:video-updater');
const db = debug('api:youtube:mongoose');

export default async function() {
  db.log('Looking for videos to update...');
  const videosToUpdate = await fetchVideosToUpdate();
  if (!videosToUpdate.length) return db.log('No videos to update.');
  db.info(`Found ${videosToUpdate.length} videos to update.`);
  logger.log(`Updating ${videosToUpdate.length} videos...`);
  const updatedVideos = await fetchYoutubeVideoData(videosToUpdate);
  logger.info(`Updated ${updatedVideos.length} videos.`);
  database.emit('update-videos', updatedVideos);
}

const fetchVideosToUpdate = () => Videos
  .find({ $or: [
    { status: { $in: ['new', 'live'] } },
    { status: 'upcoming', 'time.scheduled': { $lte: Date.now() + ONE_HOUR } }
  ] })
  .sort({ updated_at: 1 })
  .limit(50)
  .then(res => res.map(doc => doc._id));

async function fetchYoutubeVideoData(ids: VideoId[]) {
  logger.log(`Fetching ${ids.length} videos from Youtube...`);
  const result = await youtube.videos({
    part: 'snippet,liveStreamingDetails',
    fields: 'items(id,snippet,liveStreamingDetails)',
    id: ids.join(','),
    hl: 'ja'
  }).then(res => res.items.map(parseVideo));
  logger.log(`Fetched ${result?.length ?? 0} videos. Status: ${result ? 'OK' : 'ERROR'}`);
  if (result.length !== ids.length) result.push(...parseMissingVideos(ids, result) as YoutubeVideoObject[]);
  return result;
}

function parseVideo(
  { id, snippet, liveStreamingDetails }: VideoResource
): YoutubeVideoObject {
  const { channelId, title, publishedAt } = snippet ?? {};
  const { scheduledStartTime, actualStartTime, actualEndTime, concurrentViewers } = liveStreamingDetails ?? {};
  return {
    _id: id,
    platform_id: 'yt',
    channel_id: channelId,
    title,
    time: {
      published: new Date(publishedAt),
      scheduled: scheduledStartTime ? new Date(scheduledStartTime) : undefined,
      start: actualStartTime ? new Date(actualStartTime) : undefined,
      end: actualEndTime ? new Date(actualEndTime) : undefined
    },
    status: getVideoStatus(liveStreamingDetails),
    viewers: +concurrentViewers || null
  };
}

function parseMissingVideos(idList: VideoId[], videoList: YoutubeVideoObject[]) {
  const missingIds = idList.filter(_id => !videoList.find(video => video._id === _id));
  return missingIds.map(_id => ({ _id, status: 'missing' }));
}

export function getVideoStatus(liveStreamingDetails: LiveStreamingDetails) {
  if (!liveStreamingDetails) return 'uploaded';
  const { actualEndTime, actualStartTime } = liveStreamingDetails;
  /* eslint-disable indent,no-multi-spaces */
  return actualEndTime   ? 'ended'
       : actualStartTime ? 'live'
       :                   'upcoming';
  /* eslint-enable indent,no-multi-spaces */
}
