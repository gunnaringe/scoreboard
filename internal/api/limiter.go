package api

import (
	"sync"
	"time"
)

// limiter allows max events per key and minute (fixed windows). Zero or
// negative max means unlimited.
type limiter struct {
	max int
	now func() time.Time

	mu      sync.Mutex
	windows map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func newLimiter(max int) *limiter {
	return &limiter{max: max, now: time.Now, windows: map[string]*window{}}
}

func (l *limiter) allow(key string) bool {
	if l.max <= 0 {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	w := l.windows[key]
	if w == nil || now.Sub(w.start) >= time.Minute {
		if len(l.windows) > 10000 { // forget old windows so the map can't grow forever
			for k, v := range l.windows {
				if now.Sub(v.start) >= time.Minute {
					delete(l.windows, k)
				}
			}
		}
		w = &window{start: now}
		l.windows[key] = w
	}
	w.n++
	return w.n <= l.max
}
