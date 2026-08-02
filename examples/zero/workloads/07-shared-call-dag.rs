#![no_std]

fn mix(value: i32) -> i32 { value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223) }
fn left(value: i32) -> i32 { mix(value).wrapping_mul(3).wrapping_add(17) }
fn right(value: i32) -> i32 { mix(value).wrapping_mul(5).wrapping_sub(29) }
fn step(value: i32) -> i32 { left(value).wrapping_add(right(value)) }

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
