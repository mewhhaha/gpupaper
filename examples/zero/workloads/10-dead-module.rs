#![no_std]

fn dead00(value: i32) -> i32 { value.wrapping_mul(3).wrapping_add(1) }
fn dead01(value: i32) -> i32 { value.wrapping_mul(5).wrapping_add(2) }
fn dead02(value: i32) -> i32 { value.wrapping_mul(7).wrapping_add(3) }
fn dead03(value: i32) -> i32 { value.wrapping_mul(11).wrapping_add(4) }
fn dead04(value: i32) -> i32 { value.wrapping_mul(13).wrapping_add(5) }
fn dead05(value: i32) -> i32 { value.wrapping_mul(17).wrapping_add(6) }
fn dead06(value: i32) -> i32 { value.wrapping_mul(19).wrapping_add(7) }
fn dead07(value: i32) -> i32 { value.wrapping_mul(23).wrapping_add(8) }
fn dead08(value: i32) -> i32 { value.wrapping_mul(29).wrapping_add(9) }
fn dead09(value: i32) -> i32 { value.wrapping_mul(31).wrapping_add(10) }
fn dead10(value: i32) -> i32 { value.wrapping_mul(37).wrapping_add(11) }
fn dead11(value: i32) -> i32 { value.wrapping_mul(41).wrapping_add(12) }
fn dead12(value: i32) -> i32 { value.wrapping_mul(43).wrapping_add(13) }
fn dead13(value: i32) -> i32 { value.wrapping_mul(47).wrapping_add(14) }
fn dead14(value: i32) -> i32 { value.wrapping_mul(53).wrapping_add(15) }
fn dead15(value: i32) -> i32 { value.wrapping_mul(59).wrapping_add(16) }
fn step(value: i32) -> i32 { value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223) }

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
