package rating

import "math"

// MaxBalance is the most players Balance handles: it tries every split.
const MaxBalance = 14

// Candidate is a player to be placed on a team.
type Candidate struct {
	ID     string
	Rating Rating
}

// Balance splits players into two teams (sizes differ by at most one) so that
// the chance of either winning is as close to 50 % as possible. Among splits
// within 3 percentage points of the best it picks one at random, so the same
// group doesn't always get the same teams. random returns [0, 1).
func Balance(players []Candidate, handicaps map[string]Rating, random func() float64) (a, b []Candidate) {
	n := len(players)
	if n < 2 || n > MaxBalance {
		return nil, nil
	}
	half := n / 2
	type option struct {
		mask uint32
		gap  float64
	}
	var options []option
	best := math.Inf(1)
	ratings := make([]Rating, n)
	for i, p := range players {
		ratings[i] = p.Rating
	}
	split := func(mask uint32) (ra, rb []Rating) {
		for i := range players {
			if mask&(1<<i) != 0 {
				ra = append(ra, ratings[i])
			} else {
				rb = append(rb, ratings[i])
			}
		}
		return
	}
	// Player 0 always sits on team A: the mirror image is the same split.
	for mask := uint32(1); mask < 1<<n; mask += 2 {
		size := popcount(mask)
		if size != half && size != n-half {
			continue
		}
		ra, rb := split(mask)
		gap := math.Abs(WinProbability(ra, rb, handicaps) - 0.5)
		options = append(options, option{mask, gap})
		best = math.Min(best, gap)
	}
	var close []option
	for _, o := range options {
		if o.gap <= best+0.03 {
			close = append(close, o)
		}
	}
	pick := close[int(random()*float64(len(close)))%len(close)]
	for i, p := range players {
		if pick.mask&(1<<i) != 0 {
			a = append(a, p)
		} else {
			b = append(b, p)
		}
	}
	if random() < 0.5 {
		a, b = b, a
	}
	return a, b
}

func popcount(x uint32) int {
	n := 0
	for ; x != 0; x &= x - 1 {
		n++
	}
	return n
}
