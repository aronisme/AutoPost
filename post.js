const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const moment = require('moment-timezone');

const WORKDIR = process.cwd();

const POSTS_JSON_PATH = path.join(WORKDIR, 'posts.json');
const POSTED_IDS_FILE = path.join(WORKDIR, 'posted_ids.json');
const PROGRESS_FILE = path.join(WORKDIR, 'progress.json');

const RATE_LIMIT = {
  MAX_RETRIES: 5,
  BASE_DELAY: 10000,
  QUOTA_DELAY: 3600000,
  MAX_POSTS_PER_HOUR: 50
};

const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE || '';
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN || '';
const WA_PHONE = process.env.WA_PHONE || '';

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);
oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

async function sendWhatsAppMessage(message) {
  if (!ULTRAMSG_INSTANCE || !ULTRAMSG_TOKEN || !WA_PHONE) {
    console.log('⚠️ WhatsApp config incomplete, skipping notification');
    return;
  }
  try {
    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`;
    const payload = {
      token: ULTRAMSG_TOKEN,
      to: WA_PHONE,
      body: message,
      priority: 10
    };
    console.log('📤 Sending WA message:', payload);
    const response = await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    console.log('📲 WA message sent:', response.data);
    return response.data;
  } catch (error) {
    console.error('❌ WhatsApp send error:', error.message);
  }
}

async function loadPostedIds() {
  try {
    const data = await fs.readFile(POSTED_IDS_FILE, 'utf-8');
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

async function savePostedIds(postedIds) {
  await fs.writeFile(POSTED_IDS_FILE, JSON.stringify([...postedIds], null, 2));
}

async function fetchExistingTitles() {
  const allTitles = new Set();
  let nextPageToken = null;

  do {
    const params = {
      blogId: process.env.BLOG_ID,
      fetchBodies: false,
      fetchImages: false,
      maxResults: 500,
      status: ['draft', 'live'],
      pageToken: nextPageToken || undefined
    };
    try {
      const res = await blogger.posts.list(params);
      (res.data.items || []).forEach(post => allTitles.add(post.title));
      nextPageToken = res.data.nextPageToken;
    } catch (err) {
      console.error('⚠️ Failed to fetch post titles:', err.message);
      break;
    }
  } while (nextPageToken);

  return allTitles;
}

async function postToBloggerWithRetry(postData, postedIds, attempt = 1) {
  try {
    if (postedIds.has(postData.title)) {
      console.log('⏩ Skipping already posted:', postData.title);
      return { skipped: true };
    }
    const res = await blogger.posts.insert({
      blogId: process.env.BLOG_ID,
      requestBody: {
        title: postData.title,
        content: postData.content,
        labels: postData.labels || []
      }
    });
    postedIds.add(postData.title);
    await savePostedIds(postedIds);
    return { success: true, data: res.data };
  } catch (error) {
    const msg = error?.message || '';
    if ((msg.includes('ECONNRESET') || msg.includes('quotaExceeded')) && attempt < RATE_LIMIT.MAX_RETRIES) {
      const wait = msg.includes('quotaExceeded') ? RATE_LIMIT.QUOTA_DELAY : RATE_LIMIT.BASE_DELAY * 2;
      console.log(`🔁 Retrying attempt ${attempt} after waiting ${wait / 1000}s (${msg})`);
      await new Promise(resolve => setTimeout(resolve, wait));
      return postToBloggerWithRetry(postData, postedIds, attempt + 1);
    }
    throw error;
  }
}

async function postToBlogger() {
  let postsData = null;
  let progress = { lastProcessed: -1, failed: [] };

  try {
    postsData = JSON.parse(await fs.readFile(POSTS_JSON_PATH, 'utf-8'));
  } catch (err) {
    console.error('❌ Failed to read posts.json:', err.message);
    process.exit(1);
  }

  try {
    progress = JSON.parse(await fs.readFile(PROGRESS_FILE, 'utf-8'));
  } catch {
    progress = { lastProcessed: -1, failed: [] };
  }
  if (!Array.isArray(progress.failed)) progress.failed = [];

  const postedIds = await loadPostedIds();

  try {
    await sendWhatsAppMessage(`🚀 Starting job at ${moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss')} WIB\nPosts total: ${postsData.length}\nAlready posted: ${postedIds.size}`);
  } catch {}

  console.log(`Total posts: ${postsData.length}, Already posted: ${postedIds.size}`);

  const existingTitles = await fetchExistingTitles();
  console.log(`Fetched existing titles: ${existingTitles.size}`);

  let postCountSinceLastSave = 0;

  for (let i = progress.lastProcessed + 1; i < postsData.length; i++) {
    const post = postsData[i];
    console.log(`\n📝 (${i + 1}/${postsData.length}) ${post.title.substring(0, 50)}...`);

    try {
      if (existingTitles.has(post.title) || postedIds.has(post.title)) {
        console.log('⏩ Duplicate found, skipping:', post.title);
        postedIds.add(post.title);
        await savePostedIds(postedIds);
        continue;
      }

      const result = await postToBloggerWithRetry(post, postedIds);
      if (result.success) {
        console.log('✅ Posted:', result.data.url);
      }

      progress.lastProcessed = i;
      postCountSinceLastSave++;

      if (postCountSinceLastSave >= 5 || i === postsData.length - 1) {
        await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        postCountSinceLastSave = 0;
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      progress.failed.push({
        index: i,
        title: post.title,
        error: error.message
      });
      await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
      try {
        await sendWhatsAppMessage(`❌ Error posting index ${i} (${post.title}):\n${error.message}`);
      } catch {}
    }

    let delay = RATE_LIMIT.BASE_DELAY;
    if (postedIds.size >= 40 && postedIds.size < 45) delay = 30000;
    else if (postedIds.size >= 45) delay = 33000;

    if (i < postsData.length - 1) {
      console.log(`⏳ Waiting ${delay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    if ((i + 1) % 10 === 0) {
      console.log(`🔄 Progress: ${i + 1} posts processed...`);
    }
  }

  console.log('\n🎉 Processing complete!');
  const successCount = progress.lastProcessed + 1 - progress.failed.length;
  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Failed: ${progress.failed.length}`);

  if (progress.failed.length > 0) {
    await fs.writeFile('failed_posts.json', JSON.stringify(progress.failed, null, 2));
    console.log('📄 Failed posts saved to failed_posts.json');
  }

  try {
    await sendWhatsAppMessage(`🎉 Finished at ${moment().tz('Asia/Jakarta').format('YYYY-MM-DD HH:mm:ss')} WIB\n✅ Success: ${successCount}\n❌ Failed: ${progress.failed.length}`);
  } catch {}

  process.exit(0);
}

postToBlogger();
