const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { format, utcToZonedTime } = require('date-fns-tz');
const Bottleneck = require('bottleneck');

// Working directory and file paths
const WORKDIR = process.cwd();
const POSTS_JSON_PATH = path.join(WORKDIR, 'posts.json');
const POSTED_IDS_FILE = path.join(WORKDIR, 'posted_ids.json');
const PROGRESS_FILE = path.join(WORKDIR, 'progress.json');
const EXISTING_TITLES_FILE = path.join(WORKDIR, 'existing_titles.json');

// Rate limiting configuration
const RATE_LIMIT = {
  MAX_RETRIES: 5,
  BASE_DELAY: 10000, // 10 seconds
  QUOTA_DELAY: 3600000, // 1 hour
  MAX_POSTS_PER_HOUR: 50
};

// Initialize rate limiter
const limiter = new Bottleneck({
  minTime: 3600000 / RATE_LIMIT.MAX_POSTS_PER_HOUR, // Spread 50 posts over 1 hour
  maxConcurrent: 1
});

// Environment variables
const ULTRAMSG_INSTANCE = process.env.ULTRAMSG_INSTANCE || '';
const ULTRAMSG_TOKEN = process.env.ULTRAMSG_TOKEN || '';
const WA_PHONE = process.env.WA_PHONE || '';

// Google Blogger API setup
const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);
oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    console.log('🔄 New refresh token received');
    // Optionally save the new refresh token to a secure location
  }
});
const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

// Validate required environment variables
function validateEnvVars() {
  const requiredVars = ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN', 'BLOG_ID'];
  const missingVars = requiredVars.filter(v => !process.env[v]);
  if (missingVars.length > 0) {
    console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
  }
  // Warn if WhatsApp vars are missing (non-critical)
  if (!ULTRAMSG_INSTANCE || !ULTRAMSG_TOKEN || !WA_PHONE) {
    console.warn('⚠️ WhatsApp config incomplete, notifications will be skipped');
  }
}

// Load JSON file with error handling
async function loadJsonFile(filePath, defaultValue) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`⚠️ File ${filePath} not found, using default value`);
      return defaultValue;
    }
    console.error(`❌ Error reading ${filePath}:`, err.message);
    throw err;
  }
}

// Save JSON file atomically
async function saveJsonFile(filePath, data) {
  const tempFile = `${filePath}.tmp`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
    await fs.rename(tempFile, filePath);
  } catch (err) {
    console.error(`❌ Error saving ${filePath}:`, err.message);
    throw err;
  }
}

// Send WhatsApp message with retry
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
    console.error('❌ WhatsApp send error:', error.message, error.response?.data || '');
  }
}

// Generate a detailed report
async function generateReport(successCount, failedPosts, terminationReason) {
  const report = {
    timestamp: format(utcToZonedTime(new Date(), 'Asia/Jakarta'), 'yyyy-MM-dd HH:mm:ss'),
    terminationReason: terminationReason || 'Completed normally',
    totalPostsAttempted: successCount + failedPosts.length,
    successfulPosts: successCount,
    failedPosts: failedPosts,
    postedIdsCount: (await loadPostedIds()).size,
    existingTitlesCount: (await loadJsonFile(EXISTING_TITLES_FILE, [])).length
  };

  const reportPath = path.join(WORKDIR, `report_${Date.now()}.json`);
  await saveJsonFile(reportPath, report);
  console.log(`📊 Report generated at ${reportPath}`);

  // Send WhatsApp notification with report summary
  const message = `📊 Job Report (${report.timestamp} WIB)\n` +
                  `Status: ${report.terminationReason}\n` +
                  `Total Attempted: ${report.totalPostsAttempted}\n` +
                  `Successful: ${report.successfulPosts}\n` +
                  `Failed: ${report.failedPosts.length}\n` +
                  `Posted IDs: ${report.postedIdsCount}\n` +
                  `Existing Titles: ${report.existingTitlesCount}`;
  await sendWhatsAppMessage(message);

  return reportPath;
}

// Load posted IDs
async function loadPostedIds() {
  return new Set(await loadJsonFile(POSTED_IDS_FILE, []));
}

// Save posted IDs
async function savePostedIds(postedIds) {
  await saveJsonFile(POSTED_IDS_FILE, [...postedIds]);
}

// Fetch existing post titles from Blogger or cache
async function fetchExistingTitles() {
  try {
    // Try loading from cache
    const cachedTitles = await loadJsonFile(EXISTING_TITLES_FILE, []);
    if (cachedTitles.length > 0) {
      console.log('📚 Loaded existing titles from cache:', cachedTitles.length);
      return new Set(cachedTitles);
    }
  } catch {}

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

  // Cache the titles
  await saveJsonFile(EXISTING_TITLES_FILE, [...allTitles]);
  return allTitles;
}

// Post to Blogger with retry logic and enhanced rate limit detection
async function postToBloggerWithRetry(postData, postedIds, existingTitles, attempt = 1) {
  try {
    if (postedIds.has(postData.title) || existingTitles.has(postData.title)) {
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
    existingTitles.add(postData.title);
    await savePostedIds(postedIds);
    await saveJsonFile(EXISTING_TITLES_FILE, [...existingTitles]);
    return { success: true, data: res.data };
  } catch (error) {
    // Log full error for debugging
    console.error('⚠️ Error details:', {
      message: error.message,
      code: error.code,
      errors: error.errors || []
    });

    // Check for rate limit errors
    const isRateLimitError =
      error.code === 429 ||
      error.code === 403 ||
      error.message.includes('quotaExceeded') ||
      error.message.includes('Daily Limit Exceeded') ||
      error.message.includes('User Rate Limit Exceeded') ||
      error.message.includes('too many requests') ||
      (error.errors && error.errors.some(e => e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded'));

    if (isRateLimitError && attempt < RATE_LIMIT.MAX_RETRIES) {
      const wait = error.message.includes('quotaExceeded') || error.code === 403
        ? RATE_LIMIT.QUOTA_DELAY
        : error.code === 429
        ? 60000
        : RATE_LIMIT.BASE_DELAY * Math.pow(2, attempt - 1);
      console.log(`🔁 Retrying attempt ${attempt} after waiting ${wait / 1000}s (${error.message})`);
      await new Promise(resolve => setTimeout(resolve, wait));
      return postToBloggerWithRetry(postData, postedIds, existingTitles, attempt + 1);
    }

    // Throw specific error for rate limit exhaustion
    if (isRateLimitError) {
      throw new Error(`Rate limit exceeded after ${attempt} attempts: ${error.message} (code: ${error.code})`);
    }

    throw error;
  }
}

// Main function to process posts
async function postToBlogger() {
  // Validate environment variables
  validateEnvVars();

  // Load posts and progress
  let postsData = [];
  try {
    postsData = await loadJsonFile(POSTS_JSON_PATH, []);
  } catch (err) {
    console.error('❌ Failed to read posts.json:', err.message);
    process.exit(1);
  }

  let progress = await loadJsonFile(PROGRESS_FILE, { lastProcessed: -1, failed: [] });
  if (!Array.isArray(progress.failed)) progress.failed = [];

  const postedIds = await loadPostedIds();
  const existingTitles = await fetchExistingTitles();

  // Send start notification
  const startTime = format(utcToZonedTime(new Date(), 'Asia/Jakarta'), 'yyyy-MM-dd HH:mm:ss');
  await sendWhatsAppMessage(`🚀 Starting job at ${startTime} WIB\nPosts total: ${postsData.length}\nAlready posted: ${postedIds.size}`);

  console.log(`Total posts: ${postsData.length}, Already posted: ${postedIds.size}, Existing titles: ${existingTitles.size}`);

  let postCountSinceLastSave = 0;

  for (let i = progress.lastProcessed + 1; i < postsData.length; i++) {
    const post = postsData[i];
    console.log(`\n📝 (${i + 1}/${postsData.length}) ${post.title.substring(0, 50)}...`);

    try {
      const result = await limiter.schedule(() => postToBloggerWithRetry(post, postedIds, existingTitles));
      if (result.success) {
        console.log('✅ Posted:', result.data.url);
      }

      progress.lastProcessed = i;
      postCountSinceLastSave++;

      if (postCountSinceLastSave >= 5 || i === postsData.length - 1) {
        await saveJsonFile(PROGRESS_FILE, progress);
        postCountSinceLastSave = 0;
      }
    } catch (error) {
      console.error('❌ Error:', error.message);
      progress.failed.push({
        index: i,
        title: post.title,
        error: error.message
      });
      await saveJsonFile(PROGRESS_FILE, progress);
      await sendWhatsAppMessage(`❌ Error posting index ${i} (${post.title}):\n${error.message}`);

      // Check if error is due to rate limit
      if (error.message.includes('Rate limit exceeded')) {
        console.error('🚫 Rate limit reached, terminating program.');
        const successCount = progress.lastProcessed + 1 - progress.failed.length;
        await generateReport(successCount, progress.failed, `Terminated due to rate limit: ${error.message}`);
        process.exit(1);
      }
    }

    // Dynamic delay based on post count
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

  // Finalize
  console.log('\n🎉 Processing complete!');
  const successCount = progress.lastProcessed + 1 - progress.failed.length;
  console.log(`✅ Success: ${successCount}`);
  console.log(`❌ Failed: ${progress.failed.length}`);

  if (progress.failed.length > 0) {
    await saveJsonFile('failed_posts.json', progress.failed);
    console.log('📄 Failed posts saved to failed_posts.json');
  }

  const endTime = format(utcToZonedTime(new Date(), 'Asia/Jakarta'), 'yyyy-MM-dd HH:mm:ss');
  await generateReport(successCount, progress.failed, 'Completed normally');
  await sendWhatsAppMessage(`🎉 Finished at ${endTime} WIB\n✅ Success: ${successCount}\n❌ Failed: ${progress.failed.length}`);

  process.exit(0);
}

// Run the script
postToBlogger().catch(async err => {
  console.error('❌ Fatal error:', err.message, { code: err.code, errors: err.errors });
  const progress = await loadJsonFile(PROGRESS_FILE, { lastProcessed: -1, failed: [] });
  const successCount = progress.lastProcessed + 1 - progress.failed.length;
  await generateReport(successCount, progress.failed, `Fatal error: ${err.message} (code: ${err.code})`);
  process.exit(1);
});
