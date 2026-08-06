// =============================================================================
// QuotaPayload <-> AppPayload drift guard (handoff §6 gap, plan D5.1).
//
// QuotaPayload is a hand-maintained, layout-identical mirror of aztec-nr's
// AppPayload (whose `function_calls` field is private and therefore not
// iterable from the contract). These tests fail loudly if upstream ever
// changes the layout the mirror depends on:
//   - serialized-width parity (catches added/removed/resized fields),
//   - cross-deserialization semantic parity (catches field reordering),
//   - the hardcoded account-entrypoint selector golden (catches signature
//     drift in sponsor_and_hand_off's comptime string).
// Both payload types embed the SAME aztec-nr FunctionCall type, so internal
// FunctionCall changes affect both sides identically and are not a drift axis
// between them — but a width change still trips the parity asserts here.
// =============================================================================

use crate::QuotaFpc;
use aztec::{
    authwit::entrypoint::{app::AppPayload, FunctionCall},
    protocol::{
        abis::function_selector::FunctionSelector,
        address::AztecAddress,
        traits::{Deserialize, FromField, Serialize, ToField},
    },
};

global PAYLOAD_FIELDS: u32 = 31; // 5 x FunctionCall(6) + tx_nonce
global CALL_FIELDS: u32 = 6;

/// A 31-field payload image with every slot distinct and non-zero, so any
/// reordering or truncation changes observable values.
unconstrained fn distinctive_fields() -> [Field; PAYLOAD_FIELDS] {
    let mut fields = [0; PAYLOAD_FIELDS];
    for i in 0..PAYLOAD_FIELDS {
        fields[i] = (1000 + i) as Field;
    }
    // bool positions must hold valid bools; FunctionCall layout per call is
    // (args_hash, function_selector, target_address, is_public, hide_msg_sender, is_static)
    for c in 0..5 {
        fields[c * CALL_FIELDS + 3] = 0; // is_public
        fields[c * CALL_FIELDS + 4] = 0; // hide_msg_sender
        fields[c * CALL_FIELDS + 5] = 1; // is_static
    }
    fields
}

#[test]
unconstrained fn serialized_width_parity() {
    assert_eq(<QuotaFpc::QuotaPayload as Serialize>::N, <AppPayload as Serialize>::N);
    assert_eq(<QuotaFpc::QuotaPayload as Serialize>::N, PAYLOAD_FIELDS);
    assert_eq(<FunctionCall as Serialize>::N, CALL_FIELDS);
}

#[test]
unconstrained fn roundtrip_parity_through_both_types() {
    let fields = distinctive_fields();

    let quota = QuotaFpc::QuotaPayload::deserialize(fields);
    let app = AppPayload::deserialize(fields);

    // Same bytes in, same bytes out of BOTH types: field order and widths agree.
    assert_eq(quota.serialize(), fields);
    assert_eq(app.serialize(), fields);

    // Semantic anchor: tx_nonce is the final field in both layouts. If either
    // side moved it, one of these reads a FunctionCall slot instead.
    assert_eq(quota.tx_nonce, fields[PAYLOAD_FIELDS - 1]);
    assert_eq(app.tx_nonce, fields[PAYLOAD_FIELDS - 1]);
}

#[test]
unconstrained fn function_call_slot_semantics() {
    // Build a FunctionCall directly (its fields are pub upstream) and confirm
    // its serialized image lands in the exact slots the mirror assumes.
    let call = FunctionCall {
        args_hash: 111,
        function_selector: FunctionSelector::from_field(222),
        target_address: AztecAddress::from_field(333),
        is_public: false,
        hide_msg_sender: false,
        is_static: true,
    };
    let serialized = call.serialize();
    assert_eq(serialized[0], 111);
    assert_eq(serialized[1], 222);
    assert_eq(serialized[2], 333);
    assert_eq(serialized[3], 0);
    assert_eq(serialized[4], 0);
    assert_eq(serialized[5], 1);
}

#[test]
unconstrained fn entrypoint_selector_golden() {
    // sponsor_and_hand_off dispatches into the player's account with this
    // comptime selector. The golden value was verified against the
    // SchnorrInitializerlessAccount artifact (0x9d57a239); the TS suite pins
    // the same golden from the artifact side, so drift on either side trips
    // exactly one of the two tests and names the culprit.
    let selector = FunctionSelector::from_signature(
        "entrypoint(([(Field,(u32),(Field),bool,bool,bool);5],Field),u8,bool)",
    );
    assert_eq(selector.to_field(), 0x9d57a239);
}
