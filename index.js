const fs = require('fs')
const R = require('ramda')
const path = require('path')
const turf = {
  inside: require('@turf/inside'),
  centroid: require('@turf/centroid')
}
const JSONStream = require('JSONStream')
const H = require('highland')

// const graphUrl = 'https://spacetime-nypl-org.s3.amazonaws.com/datasets/spacetime-graph/spacetime-graph.objects.ndjson'
const graphPath = '/Users/bertspaan/data/spacetime/etl/aggregate/spacetime-graph/spacetime-graph.objects.ndjson'

const types = [
  'st:Building',
  'st:Person',
  'st:Address'
]

const year = 1854
const yearMargin = 5

const lowerEastSide = JSON.parse(fs.readFileSync(path.join(__dirname, 'lower-east-side.geojson')))

let indexes = {
  addressForBuilding: {},
  personsForAddress: {}
}

function indexData () {
  console.log('Indexing addresses per building')

  H(fs.createReadStream(path.join(__dirname, 'lower-east-side.objects.ndjson')))
    .split()
    .compact()
    .map(JSON.parse)
    .map(indexObject)
    .done(writeData)
}

function indexObject (object) {
  if (object.type === 'st:Address') {
    const biAddress = object.data.objects
      .filter((object) => object.id.startsWith('building-inspector/'))[0]

    const address = object.data.objects
      .filter((object) => object.id.startsWith('building-inspector-nyc-streets/'))[0]

    if (biAddress && address) {
      const biBuilding = biAddress.relations
        .filter((relation) => relation.to.startsWith('building-inspector/'))[0]

      if (!indexes.addressForBuilding[biBuilding.to]) {
        indexes.addressForBuilding[biBuilding.to] = []
      }

      indexes.addressForBuilding[biBuilding.to].push({
        name: object.name,
        id: address.id
      })
    }
  } else if (object.type === 'st:Person') {
    const cdPerson = object.data.objects
      .filter((object) => object.id.startsWith('city-directories/'))[0]

    if (cdPerson) {
      const address = cdPerson.relations
        .filter((relation) => relation.to.startsWith('building-inspector-nyc-streets/'))[0]

      if (!indexes.personsForAddress[address.to]) {
        indexes.personsForAddress[address.to] = []
      }

      indexes.personsForAddress[address.to].push({
        name: cdPerson.name,
        occupation: cdPerson.data.occupation
      })
    }
  }

  return object
}

function writeData () {
  console.log('Writing data')

  H(fs.createReadStream(path.join(__dirname, 'lower-east-side.objects.ndjson')))
    .split()
    .compact()
    .map(JSON.parse)
    .filter((object) => object.type === 'st:Building')
    .map((object) => {
      const biBuilding = object.data.objects
        .filter((object) => object.id.startsWith('building-inspector/'))[0]

      const geometry = biBuilding.geometryIndex !== undefined ? object.geometry.geometries[biBuilding.geometryIndex] : object.geometry

      let addresses
      let hasPersons = false
      if (indexes.addressForBuilding[biBuilding.id]) {
        addresses = indexes.addressForBuilding[biBuilding.id]
          .map((address) => {
            if (indexes.personsForAddress[address.id]) {
              hasPersons = true
            }

            return Object.assign(address, {
              persons: indexes.personsForAddress[address.id]
            })
          })
      }

      return {
        type: 'Feature',
        properties: {
          id: biBuilding.id,
          hasPersons,
          addresses
        },
        geometry
      }
    })
    .pipe(JSONStream.stringify('{"type":"FeatureCollection","features":[', ',\n', ']}'))
    .pipe(fs.createWriteStream(path.join(__dirname, 'lower-east-side.objects.geojson')))
    .on('finish', () => console.log('Done'))
}

function filterData () {
  console.log('Reading Space/Time graph, filtering by type and location')

  H(fs.createReadStream(graphPath))
  .split()
  .compact()
  .map(JSON.parse)
  .filter((object) => types.includes(object.type))
  .filter((object) => object.geometry)
  .filter((object) => !object.data.objects[0].id.startsWith('perris-atlas-footprints'))
  .filter((object) => {
    const validSince = parseInt(object.data.objects
      .map(R.prop('validSince'))
      .filter(R.identity)[0])

    const validUntil = parseInt(object.data.objects
      .map(R.prop('validUntil'))
      .filter(R.identity)[0])

    // TODO: use fuzzy-dates!
    return (validSince >= year - yearMargin) && (validUntil <= year + yearMargin)
  })
  .filter((object) => turf.inside(turf.centroid(object.geometry), lowerEastSide))
  .compact()
  .map(JSON.stringify)
  .intersperse('\n')
  .pipe(fs.createWriteStream(path.join(__dirname, 'lower-east-side.objects.ndjson')))
  .on('finish', indexData)
}

filterData()