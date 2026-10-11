package api

import (
	"errors"
	"fmt"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// jsonCodec replaces connect's default "json" codec so responses emit
// default-valued fields (a false `archived`, an empty list, a 0 winner) instead
// of omitting them: otherwise a JSON client cannot tell "false" from "missing".
// Optional fields that are unset are still left out, which is how clients tell
// "no score" from "0".
type jsonCodec struct{}

// JSONCodecOption overrides connect's default JSON codec with jsonCodec.
func JSONCodecOption() connect.Option { return connect.WithCodec(jsonCodec{}) }

func (jsonCodec) Name() string { return "json" }

func (jsonCodec) Marshal(message any) ([]byte, error) {
	m, ok := message.(proto.Message)
	if !ok {
		return nil, fmt.Errorf("%T doesn't implement proto.Message", message)
	}
	return protojson.MarshalOptions{EmitDefaultValues: true}.Marshal(m)
}

func (jsonCodec) Unmarshal(data []byte, message any) error {
	m, ok := message.(proto.Message)
	if !ok {
		return fmt.Errorf("%T doesn't implement proto.Message", message)
	}
	if len(data) == 0 {
		return errors.New("zero-length payload is not a valid JSON object")
	}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(data, m); err != nil {
		return fmt.Errorf("unmarshal into %T: %w", message, err)
	}
	return nil
}
