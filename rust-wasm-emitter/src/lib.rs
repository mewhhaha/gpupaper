use std::cell::RefCell;
use std::collections::HashMap;

use core::arch::wasm32::{
    i32x4_all_true, i32x4_bitmask, i32x4_eq, i32x4_ne, i32x4_splat, u16x8_extadd_pairwise_u8x16,
    u32x4_extadd_pairwise_u16x8, u32x4_extract_lane, u32x4_gt, v128, v128_and, v128_load, v128_or,
};

const ATOM_BYTE: u32 = 0;
const ATOM_UNSIGNED: u32 = 1;
const ATOM_SIGNED32: u32 = 2;
const ATOM_SIGNED64: u32 = 3;
const ATOM_LENGTH: u32 = 4;
const ATOM_WORD_COUNT: usize = 4;
const ERROR_HANDLE: u32 = u32::MAX;

#[derive(Clone, Copy)]
struct Atom {
    kind: u32,
    first: u32,
    second: u32,
    third: u32,
}

struct PlanColumns<'a> {
    kinds: &'a [u32],
    first: &'a [u32],
    second: &'a [u32],
    third: &'a [u32],
}

impl PlanColumns<'_> {
    fn atom(&self, index: usize) -> Atom {
        Atom {
            kind: self.kinds[index],
            first: self.first[index],
            second: self.second[index],
            third: self.third[index],
        }
    }
}

struct Plan {
    output: Vec<u8>,
}

#[derive(Default)]
struct EmitterState {
    input: Vec<u32>,
    plans: HashMap<u32, Plan>,
    next_handle: u32,
    active_output: Option<u32>,
    last_error: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<EmitterState> = RefCell::new(EmitterState::default());
}

#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    2
}

#[unsafe(no_mangle)]
pub extern "C" fn input_resize(word_count: u32) -> u32 {
    STATE.with_borrow_mut(|state| {
        state.input.resize(word_count as usize, 0);
        state.input.as_mut_ptr() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn prepare_plan(atom_count: u32, declared_maximum_level: u32) -> u32 {
    STATE.with_borrow_mut(|state| {
        state.last_error.clear();
        let parsed = parse_plan(&state.input, atom_count, declared_maximum_level);
        state.input.clear();
        state.input.shrink_to_fit();
        match parsed {
            Ok(plan) => {
                let handle = state.next_handle;
                if handle == ERROR_HANDLE {
                    set_error(
                        state,
                        "Rust/Wasm plan handle space is exhausted".to_string(),
                    );
                    return ERROR_HANDLE;
                }
                state.next_handle += 1;
                state.plans.insert(handle, plan);
                handle
            }
            Err(message) => {
                set_error(state, message);
                ERROR_HANDLE
            }
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn emit_plan(handle: u32) -> u32 {
    STATE.with_borrow_mut(|state| {
        state.last_error.clear();
        if !state.plans.contains_key(&handle) {
            set_error(state, format!("Rust/Wasm plan handle {handle} is not live"));
            return 1;
        }
        state.active_output = Some(handle);
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn release_plan(handle: u32) -> u32 {
    STATE.with_borrow_mut(|state| {
        state.last_error.clear();
        if state.plans.remove(&handle).is_none() {
            set_error(state, format!("Rust/Wasm plan handle {handle} is not live"));
            return 1;
        }
        if state.active_output == Some(handle) {
            state.active_output = None;
        }
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> u32 {
    STATE.with_borrow(|state| {
        state
            .active_output
            .and_then(|handle| state.plans.get(&handle))
            .map_or(0, |plan| plan.output.as_ptr() as u32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> u32 {
    STATE.with_borrow(|state| {
        state
            .active_output
            .and_then(|handle| state.plans.get(&handle))
            .map_or(0, |plan| plan.output.len() as u32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_ptr() -> u32 {
    STATE.with_borrow(|state| state.last_error.as_ptr() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn last_error_len() -> u32 {
    STATE.with_borrow(|state| state.last_error.len() as u32)
}

fn parse_plan(input: &[u32], atom_count: u32, declared_maximum_level: u32) -> Result<Plan, String> {
    if atom_count == 0 {
        return Err("Rust/Wasm plan must contain at least one atom".to_string());
    }
    let expected_words = (atom_count as usize)
        .checked_mul(ATOM_WORD_COUNT)
        .ok_or_else(|| format!("Rust/Wasm atom count {atom_count} overflows memory"))?;
    if input.len() != expected_words {
        return Err(format!(
            "Rust/Wasm plan has {} input words; {expected_words} are required for {atom_count} atoms",
            input.len()
        ));
    }
    let atom_count = atom_count as usize;
    let (kinds, remaining) = input.split_at(atom_count);
    let (first, remaining) = remaining.split_at(atom_count);
    let (second, third) = remaining.split_at(atom_count);
    let columns = PlanColumns {
        kinds,
        first,
        second,
        third,
    };
    validate_fixed_fields(&columns)?;

    let mut actual_maximum_level = 0;
    let mut length_order = Vec::new();
    for atom_index in 0..atom_count {
        let atom = columns.atom(atom_index);
        if atom.kind != ATOM_LENGTH {
            continue;
        }
        if atom.third == 0 {
            return Err(format!(
                "Rust/Wasm length atom {atom_index} has dependency level zero"
            ));
        }
        let range_end = atom.first.checked_add(atom.second).ok_or_else(|| {
            format!(
                "Rust/Wasm length atom {atom_index} range {} + {} overflows u32",
                atom.first, atom.second
            )
        })?;
        if range_end as usize > atom_count {
            return Err(format!(
                "Rust/Wasm length atom {atom_index} range [{}, {range_end}) is outside {atom_count} atoms",
                atom.first
            ));
        }
        for dependency_index in atom.first..range_end {
            let dependency = columns.atom(dependency_index as usize);
            let dependency_level = if dependency.kind == ATOM_LENGTH {
                dependency.third
            } else {
                0
            };
            if dependency_level >= atom.third {
                return Err(format!(
                    "Rust/Wasm length atom {atom_index} at level {} depends on atom {dependency_index} at level {dependency_level}",
                    atom.third
                ));
            }
        }
        actual_maximum_level = actual_maximum_level.max(atom.third);
        length_order.push(atom_index);
    }
    if actual_maximum_level != declared_maximum_level {
        return Err(format!(
            "Rust/Wasm plan declares maximum dependency level {declared_maximum_level}; atoms require {actual_maximum_level}"
        ));
    }
    length_order.sort_unstable_by_key(|atom_index| (columns.third[*atom_index], *atom_index));
    Ok(Plan {
        output: encode_plan(&columns, &length_order)?,
    })
}

fn validate_fixed_fields(columns: &PlanColumns<'_>) -> Result<(), String> {
    let vector_end = columns.kinds.len() / 4 * 4;
    for atom_index in (0..vector_end).step_by(4) {
        if simd_group_has_invalid_fixed_field(columns, atom_index) {
            for lane in 0..4 {
                validate_scalar_record(columns.atom(atom_index + lane), atom_index + lane)?;
            }
        }
    }
    for atom_index in vector_end..columns.kinds.len() {
        validate_scalar_record(columns.atom(atom_index), atom_index)?;
    }
    Ok(())
}

#[target_feature(enable = "simd128")]
fn simd_group_has_invalid_fixed_field(columns: &PlanColumns<'_>, atom_index: usize) -> bool {
    let kinds = load_vector(columns.kinds, atom_index);
    let first = load_vector(columns.first, atom_index);
    let second = load_vector(columns.second, atom_index);
    let third = load_vector(columns.third, atom_index);
    let zero = i32x4_splat(0);
    let byte_mask = i32x4_eq(kinds, zero);
    let second_reserved_mask = v128_or(
        byte_mask,
        v128_or(
            i32x4_eq(kinds, i32x4_splat(ATOM_UNSIGNED as i32)),
            i32x4_eq(kinds, i32x4_splat(ATOM_SIGNED32 as i32)),
        ),
    );
    let third_reserved_mask = i32x4_ne(kinds, i32x4_splat(ATOM_LENGTH as i32));
    let invalid = v128_or(
        u32x4_gt(kinds, i32x4_splat(ATOM_LENGTH as i32)),
        v128_or(
            v128_and(byte_mask, u32x4_gt(first, i32x4_splat(u8::MAX as i32))),
            v128_or(
                v128_and(second_reserved_mask, i32x4_ne(second, zero)),
                v128_and(third_reserved_mask, i32x4_ne(third, zero)),
            ),
        ),
    );
    i32x4_bitmask(invalid) != 0
}

#[target_feature(enable = "simd128")]
fn load_vector(column: &[u32], atom_index: usize) -> v128 {
    unsafe { v128_load(column.as_ptr().add(atom_index).cast()) }
}

fn validate_scalar_record(atom: Atom, atom_index: usize) -> Result<(), String> {
    match atom.kind {
        ATOM_BYTE => {
            if atom.first > u8::MAX as u32 {
                return Err(format!(
                    "Rust/Wasm byte atom {atom_index} must fit u8; received {}",
                    atom.first
                ));
            }
            require_zero_reserved(atom, atom_index, "byte")
        }
        ATOM_UNSIGNED => require_zero_reserved(atom, atom_index, "unsigned"),
        ATOM_SIGNED32 => require_zero_reserved(atom, atom_index, "signed32"),
        ATOM_SIGNED64 => {
            if atom.third != 0 {
                return Err(format!(
                    "Rust/Wasm signed64 atom {atom_index} has nonzero reserved word {}",
                    atom.third
                ));
            }
            Ok(())
        }
        ATOM_LENGTH => Ok(()),
        kind => Err(format!(
            "Rust/Wasm atom {atom_index} has unknown kind {kind}"
        )),
    }
}

fn require_zero_reserved(atom: Atom, atom_index: usize, kind: &str) -> Result<(), String> {
    if atom.second != 0 || atom.third != 0 {
        return Err(format!(
            "Rust/Wasm {kind} atom {atom_index} has nonzero reserved words {}, {}",
            atom.second, atom.third
        ));
    }
    Ok(())
}

fn encode_plan(columns: &PlanColumns<'_>, length_order: &[usize]) -> Result<Vec<u8>, String> {
    let atom_count = columns.kinds.len();
    let mut sizes = vec![0_u8; atom_count];
    let mut length_payloads = vec![0_u32; atom_count];
    let mut output_length = 0_u64;
    let mut atom_index = 0;
    while atom_index < atom_count {
        let all_bytes = atom_index + 4 <= atom_count
            && i32x4_all_true(i32x4_eq(
                load_vector(columns.kinds, atom_index),
                i32x4_splat(ATOM_BYTE as i32),
            ));
        if all_bytes {
            sizes[atom_index..atom_index + 4].fill(1);
            output_length += 4;
            atom_index += 4;
            continue;
        }
        let atom = columns.atom(atom_index);
        let size = match atom.kind {
            ATOM_BYTE => 1,
            ATOM_UNSIGNED => unsigned_size(atom.first),
            ATOM_SIGNED32 => signed32_size(atom.first as i32),
            ATOM_SIGNED64 => signed64_size(join_signed64(atom.first, atom.second)),
            ATOM_LENGTH => 0,
            _ => unreachable!(),
        };
        sizes[atom_index] = size;
        output_length += size as u64;
        atom_index += 1;
    }
    for atom_index in length_order.iter().copied() {
        let atom = columns.atom(atom_index);
        let range_end = atom.first + atom.second;
        let payload_length = sum_sizes(&sizes[atom.first as usize..range_end as usize]);
        if payload_length > u32::MAX as u64 {
            return Err(format!(
                "Rust/Wasm length atom {atom_index} encodes {payload_length} bytes; maximum is {}",
                u32::MAX
            ));
        }
        let payload_length = payload_length as u32;
        let size = unsigned_size(payload_length);
        sizes[atom_index] = size;
        length_payloads[atom_index] = payload_length;
        output_length += size as u64;
    }
    if output_length > u32::MAX as u64 {
        return Err(format!(
            "Rust/Wasm output length {output_length} exceeds the u32 ABI"
        ));
    }
    let mut output = Vec::with_capacity(output_length as usize);
    for (atom_index, length_payload) in length_payloads.iter().copied().enumerate() {
        let atom = columns.atom(atom_index);
        match atom.kind {
            ATOM_BYTE => output.push(atom.first as u8),
            ATOM_UNSIGNED => encode_unsigned(atom.first, &mut output),
            ATOM_SIGNED32 => encode_signed32(atom.first as i32, &mut output),
            ATOM_SIGNED64 => encode_signed64(join_signed64(atom.first, atom.second), &mut output),
            ATOM_LENGTH => encode_unsigned(length_payload, &mut output),
            _ => unreachable!(),
        }
    }
    if output.len() != output_length as usize {
        return Err(format!(
            "Rust/Wasm emission wrote {} bytes; sized output has {output_length}",
            output.len()
        ));
    }
    Ok(output)
}

#[target_feature(enable = "simd128")]
fn sum_sizes(sizes: &[u8]) -> u64 {
    let vector_end = sizes.len() / 16 * 16;
    let mut total = 0_u64;
    for byte_index in (0..vector_end).step_by(16) {
        let bytes = unsafe { v128_load(sizes.as_ptr().add(byte_index).cast()) };
        let pair_sums = u16x8_extadd_pairwise_u8x16(bytes);
        let lane_sums = u32x4_extadd_pairwise_u16x8(pair_sums);
        total += u32x4_extract_lane::<0>(lane_sums) as u64
            + u32x4_extract_lane::<1>(lane_sums) as u64
            + u32x4_extract_lane::<2>(lane_sums) as u64
            + u32x4_extract_lane::<3>(lane_sums) as u64;
    }
    total
        + sizes[vector_end..]
            .iter()
            .map(|size| *size as u64)
            .sum::<u64>()
}

fn unsigned_size(value: u32) -> u8 {
    let significant_bits = u32::BITS - value.leading_zeros();
    significant_bits.max(1).div_ceil(7) as u8
}

fn signed32_size(value: i32) -> u8 {
    let sign_mask = (value >> (i32::BITS - 1)) as u32;
    let normalized = value as u32 ^ sign_mask;
    let significant_bits = u32::BITS - normalized.leading_zeros();
    (significant_bits + 1).div_ceil(7) as u8
}

fn signed64_size(value: i64) -> u8 {
    let sign_mask = (value >> (i64::BITS - 1)) as u64;
    let normalized = value as u64 ^ sign_mask;
    let significant_bits = u64::BITS - normalized.leading_zeros();
    (significant_bits + 1).div_ceil(7) as u8
}

fn encode_unsigned(mut value: u32, output: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        output.push(byte);
        if value == 0 {
            return;
        }
    }
}

fn encode_signed32(mut value: i32, output: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        let sign_set = byte & 0x40 != 0;
        let finished = (value == 0 && !sign_set) || (value == -1 && sign_set);
        if !finished {
            byte |= 0x80;
        }
        output.push(byte);
        if finished {
            return;
        }
    }
}

fn encode_signed64(mut value: i64, output: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        let sign_set = byte & 0x40 != 0;
        let finished = (value == 0 && !sign_set) || (value == -1 && sign_set);
        if !finished {
            byte |= 0x80;
        }
        output.push(byte);
        if finished {
            return;
        }
    }
}

fn join_signed64(low: u32, high: u32) -> i64 {
    ((high as u64) << 32 | low as u64) as i64
}

fn set_error(state: &mut EmitterState, message: String) {
    state.last_error = message.into_bytes();
    state.active_output = None;
}
