# Download page design

This is a Chinese product utility for customers receiving a public file link. The only primary task is saving that file. No existing application UI or sibling design system exists.

The runtime token owner is `src/browser/download.css`: ground `#f3f5f6`, surface `#ffffff`, ink `#172a35`, accent `#075c70`, error `#a21b27`. Use the local system sans-serif font stack, flat surfaces, square controls, equal outer margins, and no decorative media or network fonts. Progress is the principal data element. Keep filename, availability, progress, controls and errors visible in the first screen.

Use native buttons, visible keyboard focus, 48px controls, responsive wrapping, tabular progress numbers, reduced-motion support and status/alert live regions. Long filenames wrap without widening the viewport. Error text is persistent and never conveyed by color alone. All actions use Chinese labels.

Opening a page never fetches bytes or counts a download. The primary action opens a native picker when supported. Otherwise a bounded Blob is allowed only through 20 MiB. Show a separate save link after verification. Large unsupported downloads show copy-link guidance. Cancellation aborts the tentative file; retry after cancellation starts over. Automatic network retries retain the current open stream and roll back the failed chunk. Only successful close means a file was committed. No refresh/restart resume is claimed.
