#![no_std]

fn mix(value: i32) -> i32 { value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223) }
fn negative(value: i32) -> i32 { value.wrapping_mul(3).wrapping_add(7) }
fn positive(value: i32) -> i32 { value.wrapping_mul(5).wrapping_sub(11) }
fn choose(value: i32) -> i32 { if value < 0 { negative(value) } else { positive(value) } }
fn step(value: i32) -> i32 { choose(mix(value)) }

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
