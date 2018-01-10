# dexcom-share

API for reading blood glucose values from Dexcom's Share servers

```js
const dexcom = require('dexcom-share')

const iterator = dexcom({
  username: 'DEXCOM_SHARE_USERNAME',
  password: 'DEXCOM_SHARE_PASSWORD'
})

while (true) {
  const { done, value } = await iterator.next()
  console.log(value)
  /*
  { DT: '/Date(1515095827000-0800)/',
    ST: '/Date(1515095827000)/',
    Trend: 4,
    Value: 123,
    WT: '/Date(1515095827000)/',
    Date: 1515095827000 }
  */
}
```
