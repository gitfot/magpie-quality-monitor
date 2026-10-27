(() => {
  "use strict";
  const target = new URL(document.body.dataset.monitorUrl);
  const entry = new URL(location.href);
  const attempt = Number(
    new URLSearchParams(entry.hash.slice(1)).get("attempt"),
  );
  entry.hash = "";
  entry.search = "";
  // Keep the host's stable entry in the fragment, never in HTTP requests.
  target.hash = new URLSearchParams({
    token: target.hash.slice(1),
    entry: entry.href,
    attempt: String(
      Number.isInteger(attempt) && attempt >= 0 ? Math.min(attempt, 2) : 0,
    ),
  }).toString();
  location.replace(target.href);
})();
