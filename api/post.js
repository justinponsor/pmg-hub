export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { platform, pageId, accessToken, mediaUrl, caption, scheduleTime } = req.body;

  try {
    if (platform === 'instagram') {
      // Step 1: Create media container
      const containerRes = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}/media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image_url: mediaUrl,
            caption,
            access_token: accessToken,
          }),
        }
      );
      const container = await containerRes.json();

      if (container.error) {
        return res.status(400).json({ error: container.error.message });
      }

      // Step 2: Publish container
      const publishRes = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}/media_publish`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            creation_id: container.id,
            access_token: accessToken,
          }),
        }
      );
      const publish = await publishRes.json();
      return res.status(200).json({ success: true, postId: publish.id });
    }

    if (platform === 'facebook') {
      const fbRes = await fetch(
        `https://graph.facebook.com/v19.0/${pageId}/photos`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: mediaUrl,
            message: caption,
            access_token: accessToken,
            published: !scheduleTime,
            scheduled_publish_time: scheduleTime || undefined,
          }),
        }
      );
      const fbData = await fbRes.json();
      return res.status(200).json({ success: true, postId: fbData.id });
    }

    return res.status(400).json({ error: 'Unknown platform' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
