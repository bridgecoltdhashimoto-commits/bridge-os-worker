const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function loadMain() {
  const script = fs.readFileSync('main.gs', 'utf8');
  const context = {
    console,
    PropertiesService: {
      getScriptProperties() {
        return { getProperty() { return ''; } };
      },
    },
    Utilities: {
      Charset: { UTF_8: 'UTF-8' },
      DigestAlgorithm: { SHA_256: 'SHA-256' },
      computeDigest() { return [1, 2, 3]; },
    },
    GmailApp: { sendEmail() {} },
  };
  context.global = context;
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'main.gs' });
  return context;
}

const context = loadMain();

{
  const mail = context.buildDeliveryMailByProduct_({
    product_key: 'estimate_front',
    product_name: 'BRIDGE 見積前受付フロント',
    mail_subject: '',
    mail_body_template: '',
  }, {
    deliveryUrl: 'https://example.com/estimate-front-delivery',
    supportFormUrl: 'https://example.com/support',
  });

  assert.strictEqual(mail.subject, '【納品】BRIDGE 見積前受付フロント ご購入ありがとうございます');
  assert.ok(mail.body.includes('購入者向け納品パッケージ'));
  assert.ok(mail.body.includes('01_導入チェックリスト'));
  assert.ok(mail.body.includes('02_受付フォーム項目テンプレート'));
  assert.ok(mail.body.includes('03_自動返信テンプレート'));
  assert.ok(mail.body.includes('04_運用ルール_免責'));
  assert.ok(mail.body.includes('Product_Master_見積前受付フロント_sample.csv'));
  assert.ok(mail.body.includes('https://example.com/estimate-front-delivery'));
  assert.ok(mail.body.includes('Square決済リンクや本番メール送信'));
  assert.ok(mail.body.includes('納品不備のご連絡窓口: https://example.com/support'));
}

{
  const mail = context.buildDeliveryMailByProduct_({
    product_key: 'proofpack_starter',
    product_name: 'BRIDGE ProofPack Starter',
    mail_subject: '',
    mail_body_template: '',
  }, {
    shopName: 'BRIDGE OS',
    deliveryUrl: 'https://example.com/proofpack',
    supportFormUrl: 'https://example.com/proofpack-support',
  });

  assert.strictEqual(mail.subject, '【納品】BRIDGE ProofPack Starter ご購入ありがとうございます');
  assert.ok(mail.body.includes('【12点セット内容】'));
  assert.ok(mail.body.includes('01_取引前チェックリスト'));
  assert.ok(!mail.body.includes('購入者向け納品パッケージ'));
}

console.log('estimate_front_delivery tests passed');
