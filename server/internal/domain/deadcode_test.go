package domain

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestDeadCodeReport_JSONRoundTrip(t *testing.T) {
	t.Parallel()

	report := DeadCodeReport{
		ProjectID:    NewProjectID(),
		GeneratedAt:  time.Date(2026, 4, 18, 12, 35, 4, 0, time.UTC),
		EntriesCount: 2,
		Entries: []DeadCodeEntry{
			{
				Kind:    NodeKindMethod,
				FQN:     "example.com/store.MongoStore.Close",
				Package: "example.com/store",
				Name:    "Close",
				File:    "store/mongo.go",
				Line:    128,
				Reason:  "unreachable",
			},
			{
				Kind:    NodeKindFunc,
				FQN:     "example.com/util.DeprecatedHelper",
				Package: "example.com/util",
				Name:    "DeprecatedHelper",
				File:    "util/helper.go",
				Line:    42,
				Reason:  "unreachable",
			},
		},
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got DeadCodeReport
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, report) {
		t.Fatalf("round trip mismatch")
	}
}
