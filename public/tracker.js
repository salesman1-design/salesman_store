// public/tracker.js

window.trackPageView = function (pageName) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page: pageName,
      timestamp: new Date().toISOString()
    })
  }).catch(err => console.warn('Tracking failed:', err));
};
