import SMS from '@alicloud/dysmsapi20170525';

export function smsReadiness(env = process.env) {
  const required = ['SMS_ACCESS_KEY_ID','SMS_ACCESS_KEY_SECRET','SMS_SIGN_NAME','SMS_TEMPLATE_CODE','ACCOUNT_OTP_SECRET'];
  return env.SMS_PROVIDER === 'aliyun' && required.every(key => Boolean(env[key])) && env.ACCOUNT_OTP_SECRET.length >= 32;
}
export function createSmsSender(env = process.env) {
  if (!smsReadiness(env)) throw new Error('SMS_NOT_CONFIGURED');
  const client = new SMS.default({ accessKeyId: env.SMS_ACCESS_KEY_ID, accessKeySecret: env.SMS_ACCESS_KEY_SECRET,
    endpoint: 'dysmsapi.aliyuncs.com', connectTimeout:5000, readTimeout:10000 });
  return async (phone, code) => {
    const response = await client.sendSms(new SMS.SendSmsRequest({ phoneNumbers:phone,signName:env.SMS_SIGN_NAME,
      templateCode:env.SMS_TEMPLATE_CODE,templateParam:JSON.stringify({code}) }));
    if (response.body?.code !== 'OK') throw new Error('SMS_DELIVERY_UNCONFIRMED');
  };
}
