#![no_std]

fn left(value: i32) -> i32 { value.wrapping_mul(3).wrapping_add(17) }
fn right(value: i32) -> i32 { value.wrapping_mul(5).wrapping_sub(29) }
fn join(value: i32) -> i32 { left(value).wrapping_add(right(value)) }
fn classify(value: i32) -> i32 { if value < 0 { value.wrapping_add(101) } else { value.wrapping_sub(103) } }
fn rotate(value: i32) -> i32 { value.wrapping_mul(9).wrapping_add(7) }
fn finish(value: i32, left_value: i32, right_value: i32) -> i32 {
    if value % 11 == 0 { value.wrapping_add(left_value) } else { value.wrapping_sub(right_value) }
}
fn step(value: i32) -> i32 {
    let left_value = left(value);
    let right_value = right(value);
    finish(rotate(classify(join(value))), left_value, right_value)
}

#[unsafe(no_mangle)]
pub extern "C" fn run(seed: i32, rounds: i32) -> i32 {
    let mut remaining = rounds;
    let mut state = seed;
    while remaining > 0 {
        state = step(state);
        remaining -= 1;
    }
    state
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! { loop {} }
