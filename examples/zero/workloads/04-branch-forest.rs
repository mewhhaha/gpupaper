#![no_std]

fn classify(value: i32) -> i32 {
    if value % 7 == 0 { return value.wrapping_add(17); }
    if value % 5 == 0 { return value.wrapping_sub(31); }
    if value < 0 { return value.wrapping_mul(3).wrapping_add(1); }
    value.wrapping_mul(5).wrapping_sub(1)
}

fn step(value: i32) -> i32 {
    classify(value.wrapping_mul(1_103_515_245).wrapping_add(12_345))
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
