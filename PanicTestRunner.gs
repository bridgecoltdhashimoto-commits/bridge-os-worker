/**
 * Panic PDF test runner.
 * Apps Script の実行プルダウンに表示させるためのラッパー関数です。
 * 本体処理は PanicPdfAddon.gs の末尾「_」付き関数を呼び出します。
 */

function run_panicSetup() {
  return panicSetup_();
}

function run_test_panic_nav_1000_form_create() {
  return test_panic_nav_1000_form_create_();
}

function run_test_panic_nav_1000_form_submit_normal() {
  return test_panic_nav_1000_form_submit_normal_();
}

function run_test_panic_nav_1000_safety_stop() {
  return test_panic_nav_1000_safety_stop_();
}

function run_test_panic_duplicate_payment() {
  return test_panic_duplicate_payment_();
}