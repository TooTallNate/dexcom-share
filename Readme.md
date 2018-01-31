# dexcom-share

This JavaScript module provides an [Async Iterator API][] for reading
blood glucose readings from Dexcom's Share servers.

### Example

```js
const dexcom = require('dexcom-share')

async function main() {
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
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
```

[Async Iterator API]: https://github.com/tc39/proposal-async-iteration
