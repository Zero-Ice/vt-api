import { config } from 'dotenv';
config();

process.env.DEBUG += ',-db:*';
import { readdirSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { MemberObject, MemberProps, PlatformId } from '../database/types/members';
import { Counter, debug, Members } from '../src/modules';
import { ChannelId } from '../src/modules/types/youtube';
import youtubeChannelScraper from './apps/scrapers/youtube-scraper';
import updateYoutube from './apps/updaters/youtube-updater';

if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is undefined!');

export function channelManager() {
  console.clear();
  console.log(
    '----------------------------   Manage Channels   ----------------------------\n' +
    ' Make sure you\'ve set up the .json files in channels/organizations directory.\n' +
    ' Check templates.json to see how to make custom channels, or move the files\n' +
    ' from the default directory to the organizations directory.\n' +
    '-----------------------------------------------------------------------------\n' +
    ' [1] Initialize (Run Everything)\n' +
    ' [2] Validate JSON Files\n' +
    ' [3] Save + Update\n' +
    ' [4] Save Channels\n' +
    ' [5] Update Channels\n' +
    ' [6] Scrape Channels\n' +
    ' [7] Drop Members and Channels Collection\n' +
    ' [8] Drop vt-api Database\n' +
    ' [9] Exit\n'
  );
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('Selection: ', async input => {
    process.env.DEBUG = process.env.DEBUG.slice(0, -6);
    rl.close();
    switch (input) {
    default:
      return channelManager();
    case '1':
      await init();
      break;
    case '2':
      validateChannels();
      break;
    case '3':
    case '4':
      await Promise.all(saveChannels({}, true));
      if (input === '4') break;
    case '5':
      await updateChannels();
      break;
    case '6':
      await scrapeChannels();
      break;
    case '7':
      await dropCollections();
      break;
    case '8':
      await dropDatabase();
      break;
    case '9': process.exit();
    }
    delayEnd();
  });
}

const delayEnd = () => setTimeout(() => {
  console.log('Press any key to continue: ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', process.exit.bind(process, 0));
}, 600);

const logger = debug('channels');
const ROOT_DIR = 'channels/organizations';

type ChannelPlatform<T> = {[key in PlatformId]: T[]};
type BasicChannelData = [ChannelId, string, PlatformId];

function saveChannel(filename: string, dry = false, save = true, async = false) {
  const groupName = filename.slice(0, -5);
  const channelList: MemberObject[] = JSON.parse(readFileSync(`${ROOT_DIR}/${filename}`, 'utf-8'));
  const parseChannel = (channel: MemberObject): any => { channel.organization = groupName; return channel; };
  const parsedChannels: MemberObject[] = channelList.map(parseChannel);
  if (dry) return parsedChannels;
  if (save) {
    const writeOp = Members
      .create(<any[]>parsedChannels)
      .then(() => logger.info(`${filename} OK`))
      .catch(err => logger.error(`${filename} CODE: ${err.code}`, err?.keyValue ?? ''));
    if (async) return writeOp;
  }
  return channelList.map((channel): BasicChannelData => [channel.channel_id, groupName, channel.platform_id]);
}

function checkChannels<T>(channelList: T[]): T[]|never {
  if (!channelList.length) {
    throw new Error('No channels found.');
  } else { return channelList; }
}

function saveChannels<T1 extends boolean, T2 extends boolean = false>(
  options: { dry?: T1; save?: boolean; } = { dry: <T1>false, save: true },
  async: T2 = <T2>false
): T2 extends true ? Promise<MemberProps[]>[] : T1 extends true ? MemberObject[] : BasicChannelData[] {
  return checkChannels(readdirSync(ROOT_DIR)
    .filter(file => file.endsWith('.json'))
    .flatMap((group): any => saveChannel(group, options.dry, options.save, async))
  ) as T2 extends true ? Promise<MemberProps[]>[] : T1 extends true ? MemberObject[] : BasicChannelData[];
}

function validateChannels() {
  try {
    const channels = saveChannels({ dry: true });
    if (!channels.length) {
      logger.error(new Error('No channel jsons found.'));
      return;
    }
    logger.info(`Found ${channels.length} channels.`);
    let errorCount = 0;
    for (let i = channels.length; i--;) {
      const err = new Members(channels[i]).validateSync();
      if (!err) continue;
      logger.error({ error: err.message, channel: channels[i] });
      errorCount++;
    }
    if (errorCount) {
      logger.info(`Failed to validate ${errorCount} channels.`);
      return false;
    } else {
      logger.info('All channels validated successfully.');
      return true;
    }
  } catch(err) {
    logger.error(err);
    return false;
  }
}

async function scrapeChannels() {
  const channelList = await Members
    .find({ crawled_at: { $exists: false } })
    .then(groupMemberObject);
  if (!Object.values(channelList).flat().length) {
    logger.error(new Error('No saved members found.'));
    return;
  }
  const scraper = {
    RESULTS: { OK: [], FAIL: [], videoCount: 0 },
    async youtube(channels: MemberObject[]) {
      for (let i = channels.length; i--;) {
        const currentChannel = channels[i];
        const [STATUS, VIDEO_COUNT] = await youtubeChannelScraper(currentChannel);
        this.RESULTS[STATUS].push(currentChannel.channel_id);
        this.RESULTS.videoCount += VIDEO_COUNT;
      }
    },
    // async bilibili(channels: MemberObject[]) {
    // },
    // async twitchtv(channels: MemberObject[]) {
    // }
  };
  await Promise.all([
    scraper.youtube(channelList.yt),
    // scraper.bilibili(channelList.bb),
    // scraper.twitchtv(channelList.tt)
  ]);
  logger.info(scraper.RESULTS);
}

async function updateChannels() {
  const CHANNEL_PLATFORMS = await Members.find()
    .then(groupMemberObject) as ChannelPlatform<MemberProps>;
  await Promise.all([
    updateYoutube(CHANNEL_PLATFORMS.yt),
    // @TODO: Implement bb and ttv apis
    // updateBilibili(CHANNEL_PLATFORMS.bb),
    // updateTwitch(CHANNEL_PLATFORMS.tt)
  ]);
}

async function dropCollections() {
  const { connection } = await require('mongoose');
  logger.info('Dropping channel related collections...');
  await Promise.all([
    connection.dropCollection('members'),
    connection.dropCollection('channels'),
    Counter.deleteOne({ _id: 'member_id' })
  ]);
  logger.info('Dropped members and channels collection.');
}

async function dropDatabase() {
  const { connection } = await require('mongoose');
  logger.info('Dropping vt-api database...');
  await connection.dropDatabase();
  logger.info('Dropped vt-api database.');
}

function groupMemberObject(memberList: MemberObject[]): ChannelPlatform<MemberObject> {
  return memberList.reduce(
    (platforms, channel) => {
      platforms[channel.platform_id].push(channel);
      return platforms;
    }, { yt: [], bb: [], tt: [] }
  );
}

export async function init(script = false) {
  if(!validateChannels()) return;
  await Promise.all(saveChannels({}, true));
  await updateChannels();
  await scrapeChannels();
  if (script) delayEnd();
}
