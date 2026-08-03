#![no_std]

fn shifted(value: i32) -> i32 { value.wrapping_add(78) }
fn square(value: i32) -> i32 { value.wrapping_mul(value) }
fn left(value: i32) -> i32 { square(shifted(value)).wrapping_mul(3) }
fn right(value: i32) -> i32 { shifted(value).wrapping_mul(5) }
fn step(value: i32) -> i32 { left(value).wrapping_add(right(value)).wrapping_add(17) }

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
