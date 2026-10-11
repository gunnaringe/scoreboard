// Package web holds the frontend. It is compiled into the binary, so editing a
// file here has no effect on a running server until it is rebuilt and restarted.
package web

import "embed"

// Assets is the static frontend: index.html is a template (see
// branding.RenderIndex); everything else is served as it is.
//
//go:embed index.html app.js i18n.js qrcodegen.js theme.js sw.js styles.css icons fonts
var Assets embed.FS
