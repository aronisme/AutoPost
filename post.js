const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const blogger = google.blogger({ version: 'v3', auth: oauth2Client });

async function postToBlogger() {
  try {
    const res = await blogger.posts.insert({
      blogId: process.env.BLOG_ID,
      requestBody: {
        title: 'Posting Otomatis dari GitHub Actions',
        content: '<p>Ini adalah isi posting otomatis yang dikirim lewat GitHub Actions.</p>',
        labels: ['otomatis', 'github']
      }
    });

    console.log('✅ Posting berhasil:', res.data.url);
  } catch (err) {
    console.error('❌ Gagal posting:', err.message);
  }
}

postToBlogger();
